/**
 * Proxy to wire.com's production backend (brig) for accounts that LIVE there.
 *
 * The fork keeps its OWN session tokens locally — so `wireAuthMiddleware`,
 * refresh and logout behave identically for local and wire.com accounts — and
 * stores Wire's access token + `zuid` cookie on the mirrored `wire_users` row
 * so directory search, connection requests and password reset run under the
 * user's real Wire identity. Tokens only ever travel back to
 * `prod-nginz-https.wire.com`.
 *
 * Response shapes are parsed defensively (brig has both legacy and qualified
 * variants in the wild); anything unexpected surfaces as a clear WireApiError
 * instead of a crash.
 *
 * Server-only. Reached through the `./api` wrappers.
 */
import { getSql, type Sql } from "@/lib/db";
import { WIRE_BACKEND_HOST } from "@/lib/messenger/types";
import { issueSession, type WireUserRow } from "./accounts.server";
import { WireApiError, WireUnauthorizedError, sha256Hex } from "./core.server";
import type { WireAuthResult, WireConnection, WireConnectionStatus, WireUser } from "./types";

const HOST = `https://${WIRE_BACKEND_HOST}`;
const TIMEOUT_MS = 9_000;
const CLIENT_LABEL = "GhostWire";

type Json = Record<string, unknown>;

function asJson(value: unknown): Json {
  return value && typeof value === "object" ? (value as Json) : {};
}

/** A Wire identifier: `"uuid"`, `{uuid, domain}` or `{id}`. */
function parseId(value: unknown): { uuid: string; domain?: string } | null {
  if (typeof value === "string" && value) return { uuid: value };
  const obj = asJson(value);
  const uuid = typeof obj.uuid === "string" ? obj.uuid : typeof obj.id === "string" ? obj.id : null;
  if (!uuid) return null;
  return { uuid, domain: typeof obj.domain === "string" ? obj.domain : undefined };
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** Public-profile fields we care about, tolerant of qualified shapes. */
interface RemoteProfile {
  id: string;
  domain?: string;
  handle: string;
  name: string;
  email: string;
  emailVerified: boolean;
  accentId: number;
  locale: string;
  createdAt: string;
}

function parseProfile(value: unknown): RemoteProfile | null {
  const obj = asJson(value);
  const id = parseId(obj.qualified_id) ?? parseId(obj.id);
  if (!id) return null;
  return {
    id: id.uuid,
    domain: id.domain,
    handle: text(obj.handle).replace(/^@/, ""),
    name: text(obj.name) || text(obj.handle) || "Wire contact",
    email: text(obj.email),
    emailVerified: obj.email_verified === true,
    accentId: typeof obj.accent_id === "number" ? obj.accent_id : 1,
    locale: text(obj.locale, "en"),
    createdAt: typeof obj.created_at === "string" ? obj.created_at : new Date().toISOString(),
  };
}

async function callWire(
  path: string,
  init: RequestInit & { token?: string; cookie?: string } = {},
): Promise<Response> {
  const { token, cookie, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("accept", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (cookie) headers.set("cookie", cookie);
  if (rest.body) headers.set("content-type", "application/json");
  try {
    return await fetch(`${HOST}${path}`, {
      ...rest,
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new WireApiError(
      `Could not reach ${WIRE_BACKEND_HOST} — check the link and try again.`,
      "unreachable",
      502,
    );
  }
}

/** Map a non-2xx brig response to a message that is safe (and useful) to show. */
async function brigError(res: Response, fallback: string): Promise<WireApiError> {
  let label = "";
  let message = "";
  try {
    const body = asJson(await res.json());
    label = text(body.label);
    message = text(body.message);
  } catch {
    /* non-JSON body */
  }
  if (res.status === 429) {
    const retry = res.headers.get("retry-after");
    return new WireApiError(
      `wire.com is limiting sign-in attempts — try again in ${retry ?? "60"}s.`,
      "throttled",
      429,
    );
  }
  if (label === "invalid-credentials" || res.status === 401) {
    return new WireApiError("wire.com rejected those credentials.", "invalid_credentials", 401);
  }
  if (label.includes("code") || /verif/i.test(message)) {
    return new WireApiError(
      message || "wire.com wants a verification code sent to your email — finish on wire.com first.",
      label || "verification_required",
      403,
    );
  }
  return new WireApiError(message || fallback, label || "remote_error", res.status);
}

// ── Sign-in ─────────────────────────────────────────────────────────────────

const zuidCookie = (res: Response): string | null => {
  const cookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const zuid = cookies.find((c) => c.startsWith("zuid="));
  if (!zuid) return null;
  return zuid.split(";")[0] ?? null;
};

/**
 * `POST /login` on wire.com → mirror the account locally and issue the fork's
 * own session, so the rest of the app cannot tell the difference.
 */
export async function remoteLogin(input: {
  email: string;
  password: string;
  clientId?: string | null;
}): Promise<WireAuthResult> {
  const identifier = input.email.trim();
  const byHandle = !identifier.includes("@");
  const body = JSON.stringify(
    byHandle
      ? { handle: identifier.replace(/^@/, "").toLowerCase(), password: input.password }
      : { email: identifier.toLowerCase(), password: input.password },
  );

  const login = await callWire("/login?persist=true", {
    method: "POST",
    body,
    headers: { "user-agent": CLIENT_LABEL },
  });
  if (!login.ok) {
    const err = await brigError(login, "wire.com sign-in failed.");
    return { ok: false, code: "invalid_credentials", error: err.message };
  }
  const tokens = asJson(await login.json());
  const accessToken = text(tokens.access_token);
  if (!accessToken) {
    return { ok: false, code: "invalid_credentials", error: "wire.com returned no access token." };
  }
  const expiresIn = typeof tokens.expires_in === "number" ? tokens.expires_in : 900;
  const cookie = zuidCookie(login);

  const selfRes = await callWire("/self", { token: accessToken });
  if (!selfRes.ok) {
    const err = await brigError(selfRes, "Signed in, but wire.com would not share your profile.");
    return { ok: false, code: "invalid_credentials", error: err.message };
  }
  const profile = parseProfile(await selfRes.json());
  if (!profile?.email) {
    return {
      ok: false,
      code: "invalid_credentials",
      error: "wire.com did not return a usable profile for this account.",
    };
  }

  const sql = await getSql();
  const handle = await uniqueMirrorHandle(sql, profile.id, profile.handle);
  const remoteExpires = new Date(Date.now() + expiresIn * 1000).toISOString();
  await sql`
    insert into wire_users
      (id, handle, email, email_verified, password_hash, name, accent_id, locale, status,
       remote_host, remote_access, remote_cookie, remote_expires_at, updated_at)
    values
      (${profile.id}, ${handle}, ${profile.email.toLowerCase()}, true,
       ${`remote:${sha256Hex(profile.id)}`}, ${profile.name}, ${profile.accentId},
       ${profile.locale}, 'active',
       ${WIRE_BACKEND_HOST}, ${accessToken}, ${cookie}, ${remoteExpires}, now())
    on conflict (id) do update set
      handle = excluded.handle,
      email = excluded.email,
      email_verified = true,
      name = excluded.name,
      accent_id = excluded.accent_id,
      locale = excluded.locale,
      status = 'active',
      remote_host = excluded.remote_host,
      remote_access = excluded.remote_access,
      remote_cookie = excluded.remote_cookie,
      remote_expires_at = excluded.remote_expires_at,
      updated_at = now()`;

  const { tokens: localTokens } = await issueSession(sql, profile.id, input.clientId ?? null);
  const row = await loadMirror(sql, profile.id);
  return {
    ok: true,
    session: {
      user: {
        id: row.id,
        handle: row.handle,
        name: row.name,
        email: row.email,
        accentId: row.accent_id,
        locale: row.locale,
        createdAt: new Date(row.created_at).toISOString(),
        emailVerified: true,
        status: "active",
      },
      tokens: localTokens,
      clientId: input.clientId ?? null,
    },
  };
}

/** The mirror row for a remote account (throws when it is missing). */
async function loadMirror(sql: Sql, userId: string): Promise<WireUserRow> {
  const rows = await sql<WireUserRow>`select * from wire_users where id = ${userId}`;
  if (!rows[0]) throw new WireApiError("Account mirror missing.", "not_found", 404);
  return rows[0];
}

/** A wire.com handle can collide with a local one — keep the mirror unique. */
async function uniqueMirrorHandle(sql: Sql, userId: string, handle: string): Promise<string> {
  const base = (handle || "wire_user").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 21) || "wire_user";
  const clash = await sql<{ id: string }>`select id from wire_users where handle = ${base}`;
  if (!clash[0] || clash[0].id === userId) return base;
  return `${base.slice(0, 14)}_${userId.slice(0, 6).replace(/-/g, "")}`;
}

// ── Authenticated proxy calls ───────────────────────────────────────────────

const domainOf = new Map<string, string>();

/** Refresh Wire's access token (POST /access needs the old token + zuid cookie). */
async function refreshRemote(sql: Sql, row: WireUserRow): Promise<void> {
  const res = await callWire("/access", {
    method: "POST",
    token: row.remote_access ?? "",
    cookie: row.remote_cookie ?? "",
  });
  if (!res.ok) {
    // The wire.com side no longer trusts this session — force a fresh sign-in.
    await sql`update wire_users set remote_access = null, remote_cookie = null,
               remote_expires_at = null where id = ${row.id}`;
    throw new WireUnauthorizedError();
  }
  const body = asJson(await res.json());
  const nextToken = text(body.access_token, row.remote_access ?? "");
  const nextExpires =
    typeof body.expires_in === "number"
      ? new Date(Date.now() + body.expires_in * 1000).toISOString()
      : new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const nextCookie = zuidCookie(res) ?? row.remote_cookie ?? null;
  await sql`
    update wire_users set remote_access = ${nextToken}, remote_cookie = ${nextCookie},
           remote_expires_at = ${nextExpires}, updated_at = now()
     where id = ${row.id}`;
}

/**
 * Call wire.com as the signed-in remote user, refreshing the token once on 401.
 * `row.remote_host` must be set — callers check first.
 */
async function remoteCall(
  sql: Sql,
  row: WireUserRow,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  if (
    !row.remote_access ||
    (row.remote_expires_at && new Date(row.remote_expires_at).getTime() < Date.now() + 30_000)
  ) {
    await refreshRemote(sql, row);
    row.remote_access = (await loadMirror(sql, row.id)).remote_access ?? row.remote_access;
    row.remote_cookie = (await loadMirror(sql, row.id)).remote_cookie ?? row.remote_cookie;
  }
  let res = await callWire(path, { ...init, token: row.remote_access ?? undefined });
  if (res.status === 401) {
    await refreshRemote(sql, row);
    row.remote_access = (await loadMirror(sql, row.id)).remote_access ?? row.remote_access;
    res = await callWire(path, { ...init, token: row.remote_access ?? undefined });
  }
  if (res.status === 401 || res.status === 403) throw new WireUnauthorizedError();
  return res;
}

/** True when this account is a mirror of one hosted on wire.com. */
export function isRemoteRow(row: WireUserRow): boolean {
  return Boolean(row.remote_host);
}

async function selfDomain(sql: Sql, row: WireUserRow): Promise<string> {
  const cached = domainOf.get(row.id);
  if (cached) return cached;
  const res = await remoteCall(sql, row, "/self");
  const domain = parseProfile(await res.json())?.domain ?? "wire.com";
  domainOf.set(row.id, domain);
  return domain;
}

// ── Directory & connections ─────────────────────────────────────────────────

async function fetchProfile(
  sql: Sql,
  row: WireUserRow,
  peer: { uuid: string; domain?: string },
): Promise<WireUser | null> {
  const domain = peer.domain ?? (await selfDomain(sql, row));
  let res = await remoteCall(sql, row, `/users/${encodeURIComponent(domain)}/${peer.uuid}`);
  if (res.status === 404 && domain !== "wire.com") {
    res = await remoteCall(sql, row, `/users/${encodeURIComponent(peer.uuid)}`);
  }
  if (!res.ok) return null;
  const profile = parseProfile(await res.json());
  if (!profile) return null;
  return {
    id: profile.id,
    handle: profile.handle,
    name: profile.name,
    // Brig's public profiles carry no email for non-contacts; the UI shows
    // handles, and accepted contacts keep whatever we last saw at sign-in.
    email: profile.email,
    accentId: profile.accentId,
    locale: profile.locale,
    createdAt: profile.createdAt,
    fingerprint: null,
  };
}

/** `GET /users?query=` on wire.com. */
export async function remoteSearchUsers(meId: string, query: string): Promise<WireUser[]> {
  const term = query.trim().replace(/^@/, "");
  if (term.length < 2) return [];
  const sql = await getSql();
  const row = await loadMirror(sql, meId);
  const res = await remoteCall(
    sql,
    row,
    `/users?query=${encodeURIComponent(term)}&size=24`,
  );
  if (!res.ok) {
    const err = await brigError(res, "wire.com directory search failed.");
    throw err;
  }
  const payload = await res.json();
  const list = Array.isArray(payload) ? payload : (asJson(payload).results ?? []);
  const users: WireUser[] = [];
  for (const entry of Array.isArray(list) ? list : []) {
    const profile = parseProfile(entry);
    if (!profile || profile.id === meId) {
      if (profile?.id === meId) {
        users.push({
          id: profile.id,
          handle: profile.handle,
          name: profile.name,
          email: row.email,
          accentId: profile.accentId,
          locale: profile.locale,
          createdAt: profile.createdAt,
          fingerprint: null,
          self: true,
        });
      }
      continue;
    }
    users.push({
      id: profile.id,
      handle: profile.handle,
      name: profile.name,
      email: profile.email,
      accentId: profile.accentId,
      locale: profile.locale,
      createdAt: profile.createdAt,
      fingerprint: null,
    });
  }
  return users;
}

/** `GET /users/{id}` on wire.com — one profile. */
export async function remoteGetUser(meId: string, userId: string): Promise<WireUser> {
  const sql = await getSql();
  const row = await loadMirror(sql, meId);
  const profile = await fetchProfile(sql, row, { uuid: userId });
  if (!profile) {
    throw new WireApiError("That wire.com account could not be loaded.", "not_found", 404);
  }
  if (profile.id === meId) profile.self = true;
  return profile;
}

/** brig's Relation → our connection status ("sent" is Wire's outgoing pending). */
function relationToStatus(status: string): WireConnectionStatus | null {
  switch (status) {
    case "accepted":
      return "accepted";
    case "pending":
      return "pending";
    case "sent":
      return "pending";
    case "blocked":
      return "blocked";
    case "ignored":
      return "ignored";
    case "cancelled":
      return "cancelled";
    case "missing-legalhold-consent":
      return "blocked";
    default:
      return null;
  }
}

/** `GET /connections` on wire.com — both directions, profiles resolved. */
export async function remoteListConnections(meId: string): Promise<WireConnection[]> {
  const sql = await getSql();
  const row = await loadMirror(sql, meId);
  const res = await remoteCall(sql, row, "/connections?size=100");
  if (!res.ok) {
    throw await brigError(res, "wire.com could not list your connections.");
  }
  const payload = await res.json();
  const list = Array.isArray(payload) ? payload : (asJson(payload).connections ?? []);
  const out: WireConnection[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(list) ? list : []) {
    const conn = asJson(entry);
    const from = parseId(conn.from)?.uuid ?? "";
    const to = parseId(conn.qualified_to) ?? parseId(conn.to);
    if (!to) continue;
    const outgoing = from === meId;
    const peer = outgoing ? to : from ? { uuid: from } : null;
    if (!peer || peer.uuid === meId) continue;
    const status = relationToStatus(text(conn.status));
    if (!status || status === "cancelled" || status === "ignored") continue;
    if (status === "accepted" && seen.has(peer.uuid)) continue;
    seen.add(peer.uuid);
    const profile = (await fetchProfile(sql, row, peer)) ?? fallbackProfile(peer.uuid);
    out.push({
      peer: {
        ...profile,
        connectionStatus: status,
        email: status === "accepted" ? profile.email : maskLike(profile.email),
      },
      status,
      message: typeof conn.message === "string" && conn.message ? conn.message : null,
      direction: outgoing ? "outgoing" : "incoming",
      updatedAt:
        typeof conn.last_update === "string" ? conn.last_update : new Date().toISOString(),
    });
  }
  return out;
}

function maskLike(email: string): string {
  if (!email) return "";
  const at = email.indexOf("@");
  return at > 0 ? `${email[0]}***${email.slice(at)}` : "***";
}

function fallbackProfile(uuid: string): WireUser {
  return {
    id: uuid,
    handle: `wire_${uuid.slice(0, 8).replace(/-/g, "")}`,
    name: "Wire contact",
    email: "",
    accentId: 1,
    locale: "en",
    createdAt: new Date().toISOString(),
    fingerprint: null,
  };
}

/** `POST /connections` on wire.com — send a contact request. */
export async function remoteCreateConnection(
  meId: string,
  targetUserId: string,
  message?: string,
): Promise<WireConnection[]> {
  const sql = await getSql();
  const row = await loadMirror(sql, meId);
  const domain = await selfDomain(sql, row);
  let res = await remoteCall(sql, row, "/connections", {
    method: "POST",
    body: JSON.stringify({ user: { uuid: targetUserId, domain }, message: message ?? null }),
  });
  if (res.status === 400) {
    // Older brig wants the bare id.
    res = await remoteCall(sql, row, "/connections", {
      method: "POST",
      body: JSON.stringify({ user: targetUserId, message: message ?? null }),
    });
  }
  if (!res.ok) throw await brigError(res, "wire.com could not send that request.");
  return remoteListConnections(meId);
}

/** `PUT /connections/{id}` on wire.com — accept / ignore / block / cancel. */
export async function remoteUpdateConnection(
  meId: string,
  peerUserId: string,
  action: "accept" | "ignore" | "block" | "cancel",
): Promise<WireConnection[]> {
  const sql = await getSql();
  const row = await loadMirror(sql, meId);
  const status =
    action === "accept"
      ? "accepted"
      : action === "ignore"
        ? "ignored"
        : action === "block"
          ? "blocked"
          : "cancelled";
  const domain = await selfDomain(sql, row);
  let res = await remoteCall(sql, row, `/connections/${encodeURIComponent(peerUserId)}`, {
    method: "PUT",
    body: JSON.stringify({ status }),
  });
  if (res.status === 404) {
    res = await remoteCall(
      sql,
      row,
      `/connections/${encodeURIComponent(domain)}/${encodeURIComponent(peerUserId)}`,
      { method: "PUT", body: JSON.stringify({ status }) },
    );
  }
  if (!res.ok) throw await brigError(res, "wire.com could not update that connection.");
  return remoteListConnections(meId);
}

// ── Password reset (brig's own flow, proxied) ───────────────────────────────

/** `POST /password-reset` — Wire emails the code to the account's address. */
export async function remotePasswordResetRequest(email: string): Promise<void> {
  const res = await callWire("/password-reset", {
    method: "POST",
    body: JSON.stringify({ email: email.trim().toLowerCase() }),
  });
  if (!res.ok) throw await brigError(res, "wire.com could not start a password reset.");
}

/** `POST /password-reset/complete` — swap in the new password on wire.com. */
export async function remotePasswordResetComplete(
  email: string,
  code: string,
  password: string,
): Promise<void> {
  const res = await callWire("/password-reset/complete", {
    method: "POST",
    body: JSON.stringify({ email: email.trim().toLowerCase(), code: code.trim(), password }),
  });
  if (!res.ok) {
    const err = await brigError(res, "wire.com rejected that reset code.");
    throw err;
  }
}

/** Best-effort revoke of the wire.com cookie (`POST /access/logout`). */
export async function remoteLogout(userId: string): Promise<void> {
  try {
    const sql = await getSql();
    const row = await loadMirror(sql, userId);
    if (!isRemoteRow(row) || !row.remote_access) return;
    await callWire("/access/logout", {
      method: "POST",
      token: row.remote_access,
      cookie: row.remote_cookie ?? "",
    });
    await sql`
      update wire_users set remote_access = null, remote_cookie = null,
             remote_expires_at = null, updated_at = now()
       where id = ${userId}`;
    domainOf.delete(userId);
  } catch {
    /* local sign-out must not fail because wire.com did */
  }
}
