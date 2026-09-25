/**
 * Wire-compatible account backend (brig): registration + email activation,
 * login / refresh / logout with opaque tokens, the profile (`/self`), device
 * registration and MLS key package upload/claim.
 *
 * Server-only. Reached through the `createServerFn` wrappers in `./api`.
 */
import { getSql, type Sql } from "@/lib/db";
import type {
  WireAuthResult,
  WireClientInfo,
  WireKeyPackage,
  WireKeyPackageBody,
  WireRegisterInput,
  WireRegisterResult,
  WireSession,
  WireSessionUser,
  WireTokens,
  WireUser,
} from "./types";
import {
  WireApiError,
  WireUnauthorizedError,
  activationCode,
  fingerprintFromJwk,
  handleFromEmail,
  hashPassword,
  maskEmail,
  normalizeHandle,
  randomToken,
  sha256Hex,
  uuid,
  verifyPassword,
} from "./core.server";
import { deliverActivationCode } from "./mail.server";

const ACCESS_TTL_SECONDS = 60 * 15; // Wire issues short-lived access tokens
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30;
const ACTIVATION_TTL_MINUTES = 15;
const MAX_KEY_PACKAGES = 5;

export interface WireUserRow {
  id: string;
  handle: string;
  email: string;
  email_verified: boolean;
  activation_code: string | null;
  activation_expires: string | Date | null;
  password_hash: string;
  name: string;
  accent_id: number;
  locale: string;
  status: "active" | "pending" | "deleted";
  created_at: string | Date;
  updated_at: string | Date;
  // Present when the account mirrors one on wire.com (migration 0004).
  reset_code?: string | null;
  reset_expires?: string | Date | null;
  remote_host?: string | null;
  remote_access?: string | null;
  remote_cookie?: string | null;
  remote_expires_at?: string | Date | null;
}

const iso = (value: string | Date): string => new Date(value).toISOString();

/** Map a `wire_users` row to Wire's public user shape. */
export function toSessionUser(row: WireUserRow): WireSessionUser {
  return {
    id: row.id,
    handle: row.handle,
    name: row.name,
    email: row.email,
    accentId: row.accent_id,
    locale: row.locale,
    createdAt: iso(row.created_at),
    emailVerified: row.email_verified,
    status: row.status,
  };
}

/** Directory shape — email masked unless the caller says otherwise. */
export function toDirectoryUser(
  row: WireUserRow,
  opts: { mask?: boolean; fingerprint?: string | null; self?: boolean; status?: WireUser["connectionStatus"] } = {},
): WireUser {
  return {
    id: row.id,
    handle: row.handle,
    name: row.name,
    email: opts.mask === false ? row.email : maskEmail(row.email),
    accentId: row.accent_id,
    locale: row.locale,
    createdAt: iso(row.created_at),
    fingerprint: opts.fingerprint ?? null,
    self: opts.self,
    connectionStatus: opts.status,
  };
}

/** The stored device fingerprint (MLS identity key) for a user, when known. */
export async function deviceFingerprint(
  sql: Sql,
  userId: string,
): Promise<string | null> {
  const rows = await sql<{ fingerprint: string | null }>`
    select fingerprint from wire_clients
    where user_id = ${userId} and fingerprint is not null
    order by created_at desc limit 1`;
  return rows[0]?.fingerprint ?? null;
}

// ── Sessions ─────────────────────────────────────────────────────────────────

/** Mint our OWN token pair for a user id (local or wire.com-mirrored). */
export async function issueSession(
  sql: Sql,
  userId: string,
  clientId: string | null,
): Promise<{ sessionId: string; tokens: WireTokens }> {
  const accessToken = randomToken(32);
  const refreshToken = randomToken(32);
  const sessionId = uuid();
  const now = Date.now();
  await sql`
    insert into wire_sessions
      (id, user_id, client_id, access_hash, refresh_hash, access_expires_at, refresh_expires_at)
    values
      (${sessionId}, ${userId}, ${clientId}, ${sha256Hex(accessToken)},
       ${sha256Hex(refreshToken)},
       ${new Date(now + ACCESS_TTL_SECONDS * 1000).toISOString()},
       ${new Date(now + REFRESH_TTL_SECONDS * 1000).toISOString()})`;
  return {
    sessionId,
    tokens: {
      accessToken,
      refreshToken,
      expiresAt: now + ACCESS_TTL_SECONDS * 1000,
      tokenType: "Bearer",
    },
  };
}

export async function loadUserRow(sql: Sql, userId: string): Promise<WireUserRow> {
  const rows = await sql<WireUserRow>`select * from wire_users where id = ${userId}`;
  if (!rows[0]) throw new WireUnauthorizedError();
  return rows[0];
}

/** Build the full session payload the client persists. */
export async function buildSession(
  sql: Sql,
  userId: string,
  tokens: WireTokens,
  clientId: string | null = null,
): Promise<WireSession> {
  const row = await loadUserRow(sql, userId);
  return { user: toSessionUser(row), tokens, clientId };
}

export type VerifiedWireCall = {
  userId: string;
  sessionId: string;
  clientId: string | null;
  user: WireSessionUser;
};

/**
 * Resolve a bearer access token to the signed-in account — the server half of
 * `wireAuthMiddleware`. Every authenticated server function goes through this;
 * a missing/expired token is a 401, never a fallback identity.
 */
export async function requireWireUser(token?: string | null): Promise<VerifiedWireCall> {
  if (!token) throw new WireUnauthorizedError();
  const sql = await getSql();
  const rows = await sql<{
    session_id: string;
    client_id: string | null;
    user_id: string;
  }>`
    select s.id as session_id, s.client_id, s.user_id
    from wire_sessions s
    where s.access_hash = ${sha256Hex(token)}
      and s.access_expires_at > now()`;
  const row = rows[0];
  if (!row) throw new WireUnauthorizedError();
  const user = await loadUserRow(sql, row.user_id);
  return {
    userId: row.user_id,
    sessionId: row.session_id,
    clientId: row.client_id,
    user: toSessionUser(user),
  };
}

// ── Registration / activation ────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * `POST /register` — create the account in Wire's pending state and send an
 * activation code, exactly the structure Wire uses before `/activation/code`.
 * When no mail provider is configured the code is returned for the in-app
 * "demo inbox" so registration stays completable in the live preview.
 */
export async function registerUser(input: WireRegisterInput): Promise<WireRegisterResult> {
  const sql = await getSql();
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  const password = input.password;

  if (!name || name.length > 64) {
    return { ok: false, code: "invalid", error: "Enter a name (max 64 characters)." };
  }
  if (!EMAIL_RE.test(email)) {
    return { ok: false, code: "invalid", error: "Enter a valid email address." };
  }
  if (password.length < 8) {
    return { ok: false, code: "invalid", error: "Password must be at least 8 characters." };
  }

  const existing = await sql<WireUserRow>`select * from wire_users where email = ${email}`;
  if (existing[0]) return { ok: false, code: "email_taken", error: "An account with this email already exists." };

  // Handle: an explicit request must be free; a derived one gets uniquified.
  let handle = normalizeHandle(input.handle ?? "");
  if (handle) {
    if (!/^[a-z0-9_]{3,21}$/.test(handle)) {
      return { ok: false, code: "invalid", error: "Handles are 3–21 characters: a–z, 0–9, _." };
    }
    const taken = await sql<WireUserRow>`select id from wire_users where handle = ${handle}`;
    if (taken[0]) return { ok: false, code: "handle_taken", error: `@${handle} is already taken.` };
  } else {
    const base = handleFromEmail(email);
    handle = base;
    for (let i = 2; ; i++) {
      const clash = await sql<WireUserRow>`select id from wire_users where handle = ${handle}`;
      if (!clash[0]) break;
      handle = `${base.slice(0, 18)}_${i}`;
    }
  }

  const id = uuid();
  const code = activationCode();
  const expires = new Date(Date.now() + ACTIVATION_TTL_MINUTES * 60 * 1000).toISOString();
  const passwordHash = await hashPassword(password);

  await sql`
    insert into wire_users
      (id, handle, email, email_verified, activation_code, activation_expires,
       password_hash, name, accent_id, locale, status)
    values
      (${id}, ${handle}, ${email}, false, ${code}, ${expires},
       ${passwordHash}, ${name}, ${1 + Math.floor(Math.random() * 6)}, ${"en"}, 'pending')`;

  const delivery = await deliverActivationCode(email, name, code);
  const row = await loadUserRow(sql, id);
  return {
    ok: true,
    user: toSessionUser(row),
    activation: { delivery, code: delivery === "in-app" ? code : undefined },
  };
}

/** `PUT /activation/code` — flip the account to verified/active. */
export async function activateAccount(
  email: string,
  code: string,
): Promise<{ ok: true } | { ok: false; code: "bad_code" | "expired"; error: string }> {
  const sql = await getSql();
  const rows = await sql.query<WireUserRow>(
    `select * from wire_users where email = $1`,
    [email.trim().toLowerCase()],
  );
  const row = rows[0];
  if (!row || !row.activation_code) {
    return { ok: false, code: "bad_code", error: "No activation pending for this email." };
  }
  if (row.activation_expires && new Date(row.activation_expires).getTime() < Date.now()) {
    return { ok: false, code: "expired", error: "That code expired — request a new one." };
  }
  if (row.activation_code !== code.trim()) {
    return { ok: false, code: "bad_code", error: "That code doesn't match." };
  }
  await sql`
    update wire_users
       set email_verified = true, status = 'active',
           activation_code = null, activation_expires = null, updated_at = now()
     where id = ${row.id}`;
  return { ok: true };
}

// ── Login / refresh / logout ─────────────────────────────────────────────────

/** `POST /login` -> `{access_token, refresh_token, expires_in, token_type}`. */
export async function loginUser(input: {
  email: string;
  password: string;
  clientId?: string | null;
}): Promise<WireAuthResult> {
  const sql = await getSql();
  const email = input.email.trim().toLowerCase();
  const rows = await sql<WireUserRow>`select * from wire_users where email = ${email}`;
  const row = rows[0];
  const ok = row ? await verifyPassword(input.password, row.password_hash) : false;
  if (!row || !ok) {
    return { ok: false, code: "invalid_credentials", error: "Wrong email or password." };
  }
  if (!row.email_verified) {
    return { ok: false, code: "needs_activation", error: "Confirm your email first." };
  }
  if (row.status === "deleted") {
    return { ok: false, code: "invalid_credentials", error: "This account was deleted." };
  }
  const { tokens } = await issueSession(sql, row.id, input.clientId ?? null);
  const session = await buildSession(sql, row.id, tokens, input.clientId ?? null);
  return { ok: true, session };
}

/** `POST /access` — exchange a refresh token for a fresh access token. */
export async function refreshSession(refreshToken: string): Promise<WireAuthResult> {
  const sql = await getSql();
  const rows = await sql<{ id: string; user_id: string; client_id: string | null }>`
    select id, user_id, client_id from wire_sessions
    where refresh_hash = ${sha256Hex(refreshToken)} and refresh_expires_at > now()`;
  const row = rows[0];
  if (!row) {
    return { ok: false, code: "expired", error: "Session expired — sign in again." };
  }
  const accessToken = randomToken(32);
  await sql`
    update wire_sessions
       set access_hash = ${sha256Hex(accessToken)},
           access_expires_at = ${new Date(Date.now() + ACCESS_TTL_SECONDS * 1000).toISOString()}
     where id = ${row.id}`;
  const tokens: WireTokens = {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + ACCESS_TTL_SECONDS * 1000,
    tokenType: "Bearer",
  };
  const session = await buildSession(sql, row.user_id, tokens, row.client_id);
  return { ok: true, session };
}

/** `DELETE /access` — revoke the current session. */
export async function logoutSession(token?: string | null): Promise<void> {
  if (!token) return;
  const sql = await getSql();
  const hash = sha256Hex(token);
  const owner = await sql<{ user_id: string }>`
    select user_id from wire_sessions where access_hash = ${hash}`;
  if (owner[0]) {
    // A mirrored wire.com account also revokes its cookie over there.
    const { remoteLogout } = await import("./remote.server");
    await remoteLogout(owner[0].user_id);
  }
  await sql`delete from wire_sessions where access_hash = ${hash}`;
}

// ── Profile (`/self`) ────────────────────────────────────────────────────────

export async function getSelf(userId: string): Promise<WireSessionUser> {
  const sql = await getSql();
  return toSessionUser(await loadUserRow(sql, userId));
}

export async function updateSelf(
  userId: string,
  patch: { name?: string; handle?: string; accentId?: number; locale?: string },
): Promise<WireSessionUser> {
  const sql = await getSql();
  if (patch.handle) {
    const handle = normalizeHandle(patch.handle);
    if (!/^[a-z0-9_]{3,21}$/.test(handle)) {
      throw new WireApiError("Handles are 3–21 characters: a–z, 0–9, _.", "invalid_handle");
    }
    const clash = await sql<WireUserRow>`select id from wire_users where handle = ${handle} and id <> ${userId}`;
    if (clash[0]) throw new WireApiError(`@${handle} is already taken.`, "handle_taken", 409);
  }
  const row = await loadUserRow(sql, userId);
  const name = patch.name?.trim() || row.name;
  const handle = patch.handle ? normalizeHandle(patch.handle) : row.handle;
  const accentId = patch.accentId ?? row.accent_id;
  const locale = patch.locale ?? row.locale;
  await sql`
    update wire_users
       set name = ${name}, handle = ${handle}, accent_id = ${accentId},
           locale = ${locale}, updated_at = now()
     where id = ${userId}`;
  return getSelf(userId);
}

// ── Devices + MLS key packages ───────────────────────────────────────────────

/**
 * `POST /clients` + `POST /mls/key-packages` in one round trip: register this
 * browser's MLS device and top the key package pool back up (packages are
 * single-use, consumed when a peer starts a conversation with us).
 */
export async function registerDevice(
  userId: string,
  input: {
    clientId: string;
    label: string;
    model: string;
    class: string;
    fingerprint: string;
    packages: WireKeyPackageBody[];
  },
): Promise<{ client: WireClientInfo; packageCount: number }> {
  const sql = await getSql();
  const nowIso = new Date().toISOString();
  await sql`
    insert into wire_clients (id, user_id, type, label, model, class, fingerprint, created_at)
    values (${input.clientId}, ${userId}, 'permanent', ${input.label}, ${input.model},
            ${input.class}, ${input.fingerprint}, ${nowIso})
    on conflict (id) do update
      set label = excluded.label, model = excluded.model,
          fingerprint = excluded.fingerprint`;

  const owned = await sql<{ id: string }>`
    select id from wire_clients where id = ${input.clientId} and user_id = ${userId}`;
  if (!owned[0]) throw new WireApiError("Device registration failed.", "device_conflict", 409);

  const countRows = await sql<{ n: number }>`
    select count(*)::int as n from wire_key_packages where user_id = ${userId}`;
  let packageCount = Number(countRows[0]?.n ?? 0);

  if (packageCount < MAX_KEY_PACKAGES && input.packages.length > 0) {
    // Replace this device's remaining packages so stale ones never linger.
    await sql`delete from wire_key_packages where client_id = ${input.clientId}`;
    const seen = new Set<string>();
    for (const body of input.packages) {
      // `ref` is a content digest and the row's primary key. Packages minted
      // with a nonce are unique, but never let a repeated digest (or two
      // racing uploads of the same batch) surface as a raw pkey violation:
      // suffix duplicates within the batch, and upsert on conflict below.
      let id = body.ref;
      for (let i = 2; seen.has(id); i += 1) id = `${body.ref}-${i}`;
      seen.add(id);
      await sql`
        insert into wire_key_packages (id, user_id, client_id, data)
        values (${id}, ${userId}, ${input.clientId}, ${JSON.stringify(body)})
        on conflict (id) do update set data = excluded.data
          where wire_key_packages.client_id = excluded.client_id`;
    }
    const recount = await sql<{ n: number }>`
      select count(*)::int as n from wire_key_packages where user_id = ${userId}`;
    packageCount = Number(recount[0]?.n ?? 0);
    await sql`
      update wire_clients set last_key_package = now() where id = ${input.clientId}`;
  }

  const clientRows = await sql<{
    id: string;
    user_id: string;
    type: "permanent" | "hidden";
    label: string;
    model: string;
    class: string;
    created_at: string | Date;
  }>`select * from wire_clients where id = ${input.clientId}`;
  const client = clientRows[0];
  if (!client) throw new WireApiError("Device registration failed.", "device_conflict", 409);
  return {
    client: {
      id: client.id,
      userId: client.user_id,
      type: client.type,
      label: client.label,
      model: client.model,
      class: client.class,
      createdAt: iso(client.created_at),
    },
    packageCount,
  };
}

/**
 * `POST /mls/key-packages/claim` — pop one key package per requested user for
 * this device's welcome messages. Packages are single-use, like Wire's.
 */
export async function claimKeyPackages(
  forUserIds: string[],
): Promise<WireKeyPackage[]> {
  const sql = await getSql();
  const claimed: WireKeyPackage[] = [];
  for (const userId of [...new Set(forUserIds)]) {
    const rows = await sql<{ id: string; user_id: string; client_id: string; data: WireKeyPackageBody }>`
      select id, user_id, client_id, data from wire_key_packages
      where user_id = ${userId}
      order by created_at asc
      limit 1`;
    const row = rows[0];
    if (!row) continue;
    const gone = await sql`delete from wire_key_packages where id = ${row.id} returning id`;
    if (!gone[0]) continue; // someone else claimed it first
    claimed.push({
      id: row.id,
      userId: row.user_id,
      clientId: row.client_id,
      data: row.data,
    });
  }
  return claimed;
}

/** Remaining key packages for the signed-in user (drives re-upload prompts). */
export async function keyPackageCount(userId: string): Promise<number> {
  const sql = await getSql();
  const rows = await sql<{ n: number }>`
    select count(*)::int as n from wire_key_packages where user_id = ${userId}`;
  return Number(rows[0]?.n ?? 0);
}

/** Fingerprint helper re-exported for API responses (matches the client's). */
export { fingerprintFromJwk };
