/**
 * Server-only primitives for the Wire-compatible backend: error type, id and
 * token generation, password hashing (scrypt) and the device fingerprint
 * algorithm shared with the client.
 *
 * NEVER import this from client code — it pulls in `node:crypto` and the DB.
 * The client talks to `@/lib/wire/api`, which dispatches here through
 * `createServerFn` handlers.
 */
import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCb,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

/**
 * An expected, user-facing API failure (bad credentials, handle taken, …).
 * Thrown like Wire would return a 4xx — the message is safe to render.
 */
export class WireApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, code = "bad_request", status = 400) {
    super(message);
    this.name = "WireApiError";
    this.code = code;
    this.status = status;
  }
}

/** Thrown by authenticated server functions when the bearer token is missing/invalid. */
export class WireUnauthorizedError extends Error {
  readonly status = 401;
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "WireUnauthorizedError";
  }
}

/** A fresh UUID (Wire-style opaque ids for users, clients, conversations…). */
export function uuid(): string {
  return randomUUID();
}

/** A URL-safe opaque token (access/refresh tokens, activation codes). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** sha256 hex digest — token lookups are by hash, never by raw token. */
export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** 6-digit activation code, the shape Wire emails on registration. */
export function activationCode(): string {
  return randomInt(0, 1_000_000)
    .toString()
    .padStart(6, "0");
}

function randomInt(min: number, max: number): number {
  const span = max - min;
  const buf = randomBytes(4);
  const value = buf.readUInt32BE(0) % span;
  return min + value;
}

// ── Passwords (scrypt) ───────────────────────────────────────────────────────
// Wire hashes account passwords with a memory-hard KDF; scrypt from node:crypto
// gives us the same property with zero dependencies. Stored as
// `scrypt$N$r$p$salt$hash` so parameters can be raised later without a flag day.
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, "base64");
  let derived: Buffer;
  try {
    derived = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// ── Fingerprints ─────────────────────────────────────────────────────────────
/**
 * Device fingerprint from an ECDSA P-256 public JWK — the SAME algorithm the
 * client runs (`sha256Hex(`${x}.${y}`)` + `formatFingerprint`), so a fingerprint
 * compared in the UI matches the one the peer computes locally.
 */
export function fingerprintFromJwk(jwk: { x?: string; y?: string } | null | undefined): string | null {
  if (!jwk?.x || !jwk?.y) return null;
  const hex = sha256Hex(`${jwk.x}.${jwk.y}`);
  return hex
    .slice(0, 32)
    .toUpperCase()
    .replace(/(.{4})/g, "$1 ")
    .trim();
}

/** Mask an email for directory results (`jane@acme.com` -> `j***@acme.com`). */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

/** Normalize + validate a handle the way Wire does (lowercase, no `@`). */
export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@/, "").toLowerCase();
}

/** Derive a handle from an email local part, uniquified by the caller. */
export function handleFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "user";
  const cleaned = normalizeHandle(local).replace(/[^a-z0-9_]/g, "") || "user";
  return cleaned.slice(0, 21);
}
