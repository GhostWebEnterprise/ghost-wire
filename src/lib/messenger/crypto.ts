const te = new TextEncoder();
const td = new TextDecoder();

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function bufToB64(buf: ArrayBuffer): string {
  return bytesToB64(new Uint8Array(buf));
}

export function randomId(prefix = "id"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `${prefix}_${bytesToB64(bytes).replace(/[+/=]/g, "").slice(0, 12)}`;
}

export function formatFingerprint(hex: string): string {
  const clean = hex.replace(/[^0-9a-f]/gi, "").toUpperCase().slice(0, 32);
  return clean.replace(/(.{4})/g, "$1 ").trim();
}

export async function sha256Hex(data: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function generateIdentity(): Promise<{
  id: string;
  fingerprint: string;
  publicJwk: JsonWebKey;
  privateJwk: JsonWebKey;
}> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const material = te.encode(`${publicJwk.x}.${publicJwk.y}`);
  const hex = await sha256Hex(material);
  return {
    id: `op_${hex.slice(0, 10)}`,
    fingerprint: formatFingerprint(hex),
    publicJwk,
    privateJwk,
  };
}

async function pbkdf2Key(secret: string, salt: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", te.encode(secret), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: 80_000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    usages,
  );
}

export async function pinHash(pin: string, saltB64?: string): Promise<{ salt: string; hash: string }> {
  const salt = saltB64 ? b64ToBytes(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const base = await crypto.subtle.importKey("raw", te.encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: 80_000, hash: "SHA-256" },
    base,
    256,
  );
  return { salt: bytesToB64(salt), hash: bufToB64(bits) };
}

export async function wrapJson(pin: string, data: unknown): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await pbkdf2Key(pin, salt, ["encrypt"]);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(JSON.stringify(data)));
  return JSON.stringify({
    v: 1,
    salt: bytesToB64(salt),
    iv: bytesToB64(iv),
    ct: bufToB64(ct),
  });
}

export async function unwrapJson<T>(pin: string, blob: string): Promise<T> {
  const parsed = JSON.parse(blob) as { salt: string; iv: string; ct: string };
  const key = await pbkdf2Key(pin, b64ToBytes(parsed.salt), ["decrypt"]);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(parsed.iv) as BufferSource },
    key,
    b64ToBytes(parsed.ct) as BufferSource,
  );
  return JSON.parse(td.decode(pt)) as T;
}

export async function deriveRoomKey(code: string): Promise<CryptoKey> {
  const salt = te.encode("ghostwire-room-v1");
  const base = await crypto.subtle.importKey("raw", te.encode(code.toLowerCase()), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 50_000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptText(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(plaintext));
  return `${bytesToB64(iv)}.${bufToB64(ct)}`;
}

export async function decryptText(key: CryptoKey, payload: string): Promise<string> {
  const [ivB64, ctB64] = payload.split(".");
  if (!ivB64 || !ctB64) throw new Error("malformed payload");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(ivB64) as BufferSource },
    key,
    b64ToBytes(ctB64) as BufferSource,
  );
  return td.decode(pt);
}

export function generateInviteCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `GW-${out.slice(0, 4)}-${out.slice(4)}`;
}

export function roomIdFromCode(code: string): string {
  const compact = code.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return compact.slice(0, 64);
}

export function displayCode(code: string): string {
  const compact = code.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  if (compact.startsWith("GW") && compact.length >= 10) {
    return `GW-${compact.slice(2, 6)}-${compact.slice(6, 10)}`;
  }
  return compact;
}
