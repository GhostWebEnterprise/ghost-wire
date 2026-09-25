/**
 * MLS-structured messaging crypto for the client.
 *
 * Mirrors Wire's MLS flow with WebCrypto primitives that both the browser and
 * Node support, so every step is real cryptography rather than a placeholder:
 *
 *   device identity -> ECDSA P-256 signing key (fingerprint, message signing)
 *   key package     -> signed public init key, uploaded single-use to the backend
 *   welcome         -> ephemeral ECDH P-256 -> HKDF-SHA256 -> AES-256-GCM seal
 *                      of the conversation's epoch secret, per member device
 *   commit/epoch    -> the epoch secret is the group key; a membership change
 *                      mints a new epoch (a new welcome round)
 *   application msg -> AES-256-GCM under the epoch key, with the conversation,
 *                      epoch, sender and type bound in as additional data
 *
 * The backend only ever stores ciphertext: key packages, welcome envelopes and
 * message payloads are opaque blobs in `migrations/0002_wire.sql`.
 *
 * Browser-only — all of it runs in the page (like the real Wire client's
 * core-crypto), and everything persists in `localStorage`.
 */
import { formatFingerprint, sha256Hex } from "@/lib/messenger/crypto";
import type { WirePlaintext, WireWelcomeEnvelope } from "./types";

const te = new TextEncoder();
const td = new TextDecoder();

const DEVICE_KEY = "ghostwire-mls-device-v1";
const EPOCH_KEY = "ghostwire-mls-epochs-v1";

/** The MLS cipher-suite label reported to the backend (Wire-style naming). */
export const WIRE_CIPHER_SUITE = "P256_HKDF_SHA256_AES128GCM_P256_SHA256";

/** This device's MLS identity: signing key + key-package init key. */
export interface DeviceKeys {
  v: 1;
  /** Client id registered with the backend for this browser. */
  clientId: string;
  label: string;
  signing: { public: JsonWebKey; private: JsonWebKey };
  init: { public: JsonWebKey; private: JsonWebKey };
  /** Device fingerprint (matches what peers compute from the key package). */
  fingerprint: string;
  createdAt: number;
}

/** The group key material for one conversation epoch. */
export interface EpochRecord {
  epoch: number;
  /** base64 epoch secret — the AES-GCM key for application messages. */
  secret: string;
  /** Which welcome delivered this secret (dedupe marker). */
  welcomeId?: string;
  updatedAt: number;
}

// ── base64 helpers ───────────────────────────────────────────────────────────

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(value: string): Uint8Array {
  const s = atob(value);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function bufToB64(buf: ArrayBuffer): Promise<string> {
  return toB64(new Uint8Array(buf));
}

// ── key helpers ──────────────────────────────────────────────────────────────

async function importSigningPublic(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, true, [
    "verify",
  ]);
}

async function importSigningPrivate(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

async function importInitPublic(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, []);
}

async function importInitPrivate(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
}

async function importEpochKey(secretB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromB64(secretB64) as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return `${prefix}_${toB64(bytes).replace(/[+/=]/g, "")}`;
}

/** 256-bit epoch secret, base64. */
export function newEpochSecret(): string {
  return toB64(crypto.getRandomValues(new Uint8Array(32)));
}

// ── storage ──────────────────────────────────────────────────────────────────

/** Read the device keys, or `null` when this device hasn't joined MLS yet. */
export function loadDeviceKeys(): DeviceKeys | null {
  try {
    const raw = localStorage.getItem(DEVICE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DeviceKeys;
    return parsed?.v === 1 && parsed.signing && parsed.init ? parsed : null;
  } catch {
    return null;
  }
}

function saveDeviceKeys(keys: DeviceKeys): void {
  localStorage.setItem(DEVICE_KEY, JSON.stringify(keys));
}

/**
 * Load this device's MLS identity, creating it on first use. The client id is
 * minted here so the key pair and the backend client row always line up.
 */
export async function loadOrCreateDeviceKeys(): Promise<DeviceKeys> {
  const existing = loadDeviceKeys();
  if (existing) return existing;

  const signing = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const init = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveKey",
    "deriveBits",
  ]);
  const signingPublic = await crypto.subtle.exportKey("jwk", signing.publicKey);
  const signingPrivate = await crypto.subtle.exportKey("jwk", signing.privateKey);
  const initPublic = await crypto.subtle.exportKey("jwk", init.publicKey);
  const initPrivate = await crypto.subtle.exportKey("jwk", init.privateKey);

  const material = te.encode(`${signingPublic.x}.${signingPublic.y}`);
  const fingerprint = formatFingerprint(await sha256Hex(material));

  const keys: DeviceKeys = {
    v: 1,
    clientId: randomId("c"),
    label: deviceLabel(),
    signing: { public: signingPublic, private: signingPrivate },
    init: { public: initPublic, private: initPrivate },
    fingerprint,
    createdAt: Date.now(),
  };
  saveDeviceKeys(keys);
  return keys;
}

function deviceLabel(): string {
  if (typeof navigator === "undefined") return "GhostWire";
  return /Android/i.test(navigator.userAgent) ? "GhostWire for Android" : "GhostWire";
}

/** Which device class to register with the backend. */
export function deviceClass(): { label: string; model: string; class: string } {
  const android = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
  return {
    label: deviceLabel(),
    model: android ? "Android" : "Web",
    class: android ? "phone" : "desktop",
  };
}

/** Forget this device's MLS material (called on sign-out). */
export function clearWireCrypto(): void {
  try {
    localStorage.removeItem(DEVICE_KEY);
    localStorage.removeItem(EPOCH_KEY);
  } catch {
    /* ignore */
  }
}

// ── epoch store ──────────────────────────────────────────────────────────────

export function loadEpoch(conversationId: string): EpochRecord | null {
  try {
    const raw = localStorage.getItem(EPOCH_KEY);
    if (!raw) return null;
    const all = JSON.parse(raw) as Record<string, EpochRecord>;
    return all[conversationId] ?? null;
  } catch {
    return null;
  }
}

export function saveEpoch(conversationId: string, record: EpochRecord): void {
  let all: Record<string, EpochRecord> = {};
  try {
    const raw = localStorage.getItem(EPOCH_KEY);
    if (raw) all = JSON.parse(raw) as Record<string, EpochRecord>;
  } catch {
    all = {};
  }
  all[conversationId] = record;
  localStorage.setItem(EPOCH_KEY, JSON.stringify(all));
}

/** Every epoch key this device holds — the restore half of a vault backup. */
export function exportEpochs(): Record<string, EpochRecord> {
  try {
    const raw = localStorage.getItem(EPOCH_KEY);
    return raw ? (JSON.parse(raw) as Record<string, EpochRecord>) : {};
  } catch {
    return {};
  }
}

/**
 * Merge epoch keys from a backup into this device. Keeps whichever key is at
 * the higher epoch per conversation (a stale secret can't decrypt newer
 * ciphertext, but the reverse would lose history), and returns how many
 * conversations gained a key.
 */
export function importEpochs(all: Record<string, EpochRecord> | null | undefined): number {
  if (!all || typeof all !== "object") return 0;
  let current: Record<string, EpochRecord> = {};
  try {
    const raw = localStorage.getItem(EPOCH_KEY);
    current = raw ? (JSON.parse(raw) as Record<string, EpochRecord>) : {};
  } catch {
    /* no keys on this device yet */
  }
  let merged = 0;
  for (const [conversationId, record] of Object.entries(all)) {
    if (!record || typeof record.epoch !== "number" || typeof record.secret !== "string") continue;
    const existing = current[conversationId];
    if (existing && existing.epoch >= record.epoch) continue;
    current[conversationId] = record;
    merged += 1;
  }
  localStorage.setItem(EPOCH_KEY, JSON.stringify(current));
  return merged;
}

// ── key packages ─────────────────────────────────────────────────────────────

/** The signed portion of a key package (everything but ref/signature). */
export type PackageCore = {
  v: 1;
  cipherSuite: string;
  clientId: string;
  initKey: JsonWebKey;
  signingKey: JsonWebKey;
  /**
   * Random per-package salt. Packages are addressed by a digest of this
   * content (`ref` is the backend's primary key), so two packages minted from
   * one device must never be byte-identical — otherwise the second insert of
   * every upload batch trips `wire_key_packages_pkey`. Optional so packages
   * minted before the salt existed still verify.
   */
  nonce?: string;
};

/** Canonical byte string every key package signature covers. */
function packageCanonical(body: PackageCore): string {
  const pub = (jwk: JsonWebKey) => ({ crv: jwk.crv, x: jwk.x, y: jwk.y });
  const core = {
    v: body.v,
    cipherSuite: body.cipherSuite,
    clientId: body.clientId,
    initKey: pub(body.initKey),
    signingKey: pub(body.signingKey),
  };
  return body.nonce ? JSON.stringify({ ...core, nonce: body.nonce }) : JSON.stringify(core);
}

/**
 * Build a single-use key package: public init key + device identity key,
 * signed by the device. Upload these to the backend; peers claim one whenever
 * they start a conversation with this device.
 */
export async function createKeyPackage(keys: DeviceKeys): Promise<PackageCore & {
  ref: string;
  signature: string;
}> {
  const core: PackageCore = {
    v: 1,
    cipherSuite: WIRE_CIPHER_SUITE,
    clientId: keys.clientId,
    initKey: pickPublic(keys.init.public),
    signingKey: pickPublic(keys.signing.public),
    nonce: toB64(crypto.getRandomValues(new Uint8Array(16))),
  };
  const canonical = packageCanonical(core);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    await importSigningPrivate(keys.signing.private),
    te.encode(canonical),
  );
  const ref = (await sha256Hex(te.encode(canonical))).slice(0, 32);
  return { ...core, ref, signature: await bufToB64(signature) };
}

/** Keep only the public curve coordinates (stable across JSON round-trips). */
function pickPublic(jwk: JsonWebKey): JsonWebKey {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true } as JsonWebKey;
}

/** Verify a key package's signature (used before sealing a welcome to it). */
export async function verifyKeyPackage(pkg: PackageCore & { signature: string }): Promise<boolean> {
  try {
    const canonical = packageCanonical(pkg);
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      await importSigningPublic(pkg.signingKey),
      fromB64(pkg.signature) as BufferSource,
      te.encode(canonical),
    );
    return ok;
  } catch {
    return false;
  }
}

// ── welcome (epoch secret seal) ──────────────────────────────────────────────

function welcomeInfo(conversationId: string, epoch: number, recipientClientId: string): string {
  return `ghostwire-mls-welcome|${conversationId}|${epoch}|${recipientClientId}`;
}

/**
 * Seal the conversation's epoch secret to each member device's key package
 * init key (MLS welcome). Only the holder of that private key can open it.
 */
export async function buildWelcomes(input: {
  conversationId: string;
  epoch: number;
  secret: string;
  members: { clientId: string; initKey: JsonWebKey }[];
}): Promise<WireWelcomeEnvelope[]> {
  const out: WireWelcomeEnvelope[] = [];
  for (const member of input.members) {
    const info = welcomeInfo(input.conversationId, input.epoch, member.clientId);
    const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ]);
    const shared = await crypto.subtle.deriveBits(
      { name: "ECDH", public: await importInitPublic(member.initKey) },
      eph.privateKey,
      256,
    );
    const hkdf = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
    const okm = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: te.encode(input.conversationId), info: te.encode(info) },
      hkdf,
      256,
    );
    const key = await crypto.subtle.importKey("raw", okm, "AES-GCM", false, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: te.encode(info) },
      key,
      te.encode(input.secret),
    );
    out.push({
      v: 1,
      epk: await crypto.subtle.exportKey("jwk", eph.publicKey),
      iv: await bufToB64(iv.buffer as ArrayBuffer),
      ct: await bufToB64(ct),
      info,
    });
  }
  return out;
}

/**
 * Open a welcome addressed to this device and return the epoch secret.
 * Returns `null` when the envelope isn't for us (wrong client/epoch/conv).
 */
export async function openWelcome(input: {
  envelope: WireWelcomeEnvelope;
  keys: DeviceKeys;
  conversationId: string;
  epoch: number;
}): Promise<string | null> {
  try {
    const expected = welcomeInfo(input.conversationId, input.epoch, input.keys.clientId);
    if (input.envelope.info !== expected) return null;
    const shared = await crypto.subtle.deriveBits(
      { name: "ECDH", public: await importInitPublic(input.envelope.epk) },
      await importInitPrivate(input.keys.init.private),
      256,
    );
    const hkdf = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
    const okm = await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: te.encode(input.conversationId),
        info: te.encode(expected),
      },
      hkdf,
      256,
    );
    const key = await crypto.subtle.importKey("raw", okm, "AES-GCM", false, ["decrypt"]);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(input.envelope.iv) as BufferSource, additionalData: te.encode(expected) },
      key,
      fromB64(input.envelope.ct) as BufferSource,
    );
    return td.decode(pt);
  } catch {
    return null;
  }
}

// ── application messages ─────────────────────────────────────────────────────

// No explicit return type: `TextEncoder#encode` yields `Uint8Array<ArrayBuffer>`
// (WebCrypto's BufferSource), while a bare `Uint8Array` annotation would widen
// it to `ArrayBufferLike` and fail the DOM lib's stricter generic.
function messageAad(
  conversationId: string,
  epoch: number,
  senderUser: string,
  senderClient: string,
  type: string,
) {
  return te.encode(JSON.stringify([conversationId, epoch, senderUser, senderClient, type]));
}

/**
 * Encrypt an application message under the conversation's epoch key.
 * Returns `v1.<iv>.<ciphertext>` (base64) — the opaque payload the backend
 * stores in `wire_messages`.
 */
export async function encryptMessage(input: {
  secret: string;
  conversationId: string;
  epoch: number;
  sender: { user: string; client: string };
  type: WirePlaintext["type"];
  body: string;
  at?: number;
}): Promise<string> {
  const plaintext: WirePlaintext = {
    v: 1,
    type: input.type,
    body: input.body,
    at: input.at ?? Date.now(),
    sender: input.sender,
  };
  const key = await importEpochKey(input.secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: messageAad(
        input.conversationId,
        input.epoch,
        input.sender.user,
        input.sender.client,
        input.type,
      ),
    },
    key,
    te.encode(JSON.stringify(plaintext)),
  );
  return `v1.${await bufToB64(iv.buffer as ArrayBuffer)}.${await bufToB64(ct)}`;
}

/**
 * Decrypt a stored payload. The server-provided envelope fields (conversation,
 * epoch, sender, type) are the AAD, so a ciphertext can't be replayed into a
 * different conversation, epoch or sender. Returns `null` when the payload
 * isn't ours or the epoch key is missing.
 */
export async function decryptMessage(input: {
  secret: string;
  payload: string;
  conversationId: string;
  epoch: number;
  sender: { user: string; client: string };
  contentType: string;
}): Promise<WirePlaintext | null> {
  try {
    const [version, ivB64, ctB64] = input.payload.split(".");
    if (version !== "v1" || !ivB64 || !ctB64) return null;
    // The stored content type is the plaintext type and is part of the AAD.
    const type = input.contentType as WirePlaintext["type"];
    const key = await importEpochKey(input.secret);
    const pt = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromB64(ivB64) as BufferSource,
        additionalData: messageAad(
          input.conversationId,
          input.epoch,
          input.sender.user,
          input.sender.client,
          type,
        ),
      },
      key,
      fromB64(ctB64) as BufferSource,
    );
    const parsed = JSON.parse(td.decode(pt)) as WirePlaintext;
    if (parsed.v !== 1) return null;
    if (parsed.sender.user !== input.sender.user || parsed.sender.client !== input.sender.client) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
