/**
 * Wire-compatible social graph (brig): directory lookups and connections —
 * the contact structure this fork adds people through.
 *
 * Server-only. Reached through `./api`.
 */
import { getSql, type Sql } from "@/lib/db";
import { WireApiError, maskEmail, normalizeHandle } from "./core.server";
import {
  deviceFingerprint,
  loadUserRow,
  toDirectoryUser,
  type WireUserRow,
} from "./accounts.server";
import {
  isRemoteRow,
  remoteCreateConnection,
  remoteGetUser,
  remoteListConnections,
  remoteSearchUsers,
  remoteUpdateConnection,
} from "./remote.server";
import type { WireConnection, WireConnectionStatus, WireUser } from "./types";

/** One of Wire's connection states, enforced server-side. */
const CONNECTION_STATUSES: WireConnectionStatus[] = [
  "pending",
  "accepted",
  "ignored",
  "blocked",
  "cancelled",
];

function isStatus(value: string): value is WireConnectionStatus {
  return (CONNECTION_STATUSES as string[]).includes(value);
}

/**
 * Resolve a user's connection status with me, from MY side of the pair —
 * Wire keeps one row per direction, so both lookups are needed to decide what
 * the UI should offer.
 */
async function myStatusWith(sql: Sql, meId: string, otherId: string): Promise<WireConnectionStatus | "none"> {
  const outgoing = await sql<{ status: string }>`
    select status from wire_connections
    where from_user = ${meId} and to_user = ${otherId}`;
  if (outgoing[0] && isStatus(outgoing[0].status)) {
    // An incoming accepted row + my outgoing accepted row is still "accepted".
    return outgoing[0].status;
  }
  const incoming = await sql<{ status: string }>`
    select status from wire_connections
    where from_user = ${otherId} and to_user = ${meId}`;
  if (incoming[0] && isStatus(incoming[0].status)) {
    if (incoming[0].status === "pending") return "pending";
    if (incoming[0].status === "accepted") return "accepted";
    if (incoming[0].status === "blocked") return "blocked";
    if (incoming[0].status === "cancelled") return "none";
    return incoming[0].status;
  }
  return "none";
}

/**
 * `GET /users?query=` — directory lookup by handle, name or email prefix.
 * Wire returns limited profiles for anyone matching; emails come masked and
 * the caller's own account is tagged `self`.
 */
export async function searchUsers(meId: string, query: string): Promise<WireUser[]> {
  const sql = await getSql();
  // wire.com-mirrored accounts search Wire's production directory instead.
  const me = await loadUserRow(sql, meId);
  if (isRemoteRow(me)) return remoteSearchUsers(meId, query);
  const raw = query.trim();
  if (raw.length < 2) return [];
  const term = raw.replace(/^@/, "").toLowerCase();
  const like = `%${term.replace(/[%_]/g, "")}%`;
  const rows = await sql<WireUserRow>`
    select * from wire_users
    where status <> 'deleted'
      and (lower(handle) like ${like} or lower(name) like ${like} or lower(email) like ${like})
    order by
      case when lower(handle) = ${term} then 0
           when lower(handle) like ${term} || '%' then 1
           else 2 end,
      name asc
    limit 12`;
  const results: WireUser[] = [];
  for (const row of rows) {
    const status = row.id === meId ? undefined : await myStatusWith(sql, meId, row.id);
    results.push(
      toDirectoryUser(row, {
        mask: true,
        fingerprint: await deviceFingerprint(sql, row.id),
        self: row.id === meId,
        status,
      }),
    );
  }
  return results;
}

/** `GET /users/{id}` — one profile (used when opening a request). */
export async function getUser(meId: string, userId: string): Promise<WireUser> {
  const sql = await getSql();
  const me = await loadUserRow(sql, meId);
  if (isRemoteRow(me)) return remoteGetUser(meId, userId);
  const rows = await sql<WireUserRow>`select * from wire_users where id = ${userId}`;
  const row = rows[0];
  if (!row || row.status === "deleted") throw new WireApiError("User not found.", "not_found", 404);
  const status = row.id === meId ? undefined : await myStatusWith(sql, meId, row.id);
  return toDirectoryUser(row, {
    mask: false,
    fingerprint: await deviceFingerprint(sql, row.id),
    self: row.id === meId,
    status,
  });
}

interface ConnectionRow {
  from_user: string;
  to_user: string;
  status: string;
  message: string | null;
  updated_at: string | Date;
}

/** `GET /connections` — the contact list, in both directions. */
export async function listConnections(meId: string): Promise<WireConnection[]> {
  const sql = await getSql();
  const me = await loadUserRow(sql, meId);
  if (isRemoteRow(me)) return remoteListConnections(meId);
  // One query for the edges (no join with wire_users: both tables carry a
  // `status` column and duplicate output names collide in pg row parsing),
  // then resolve each peer profile.
  const rows = await sql<ConnectionRow>`
    select from_user, to_user, status, message, updated_at
      from wire_connections
     where from_user = ${meId} or to_user = ${meId}
     order by updated_at desc`;

  const out: WireConnection[] = [];
  for (const row of rows) {
    if (!isStatus(row.status)) continue;
    const outgoing = row.from_user === meId;
    const peerId = outgoing ? row.to_user : row.from_user;
    let peerRow: WireUserRow;
    try {
      peerRow = await loadUserRow(sql, peerId);
    } catch {
      continue; // peer account removed — skip the edge
    }
    if (peerRow.status === "deleted") continue;
    out.push({
      peer: toDirectoryUser(peerRow, {
        mask: row.status !== "accepted",
        fingerprint: await deviceFingerprint(sql, peerId),
        self: false,
        status: row.status,
      }),
      status: row.status,
      message: row.message,
      direction: outgoing ? "outgoing" : "incoming",
      updatedAt: new Date(row.updated_at).toISOString(),
    });
  }
  return out;
}

/**
 * `POST /connections` — request a contact (Wire's pending state). Requesting
 * someone who already requested me auto-accepts, exactly as Wire does.
 */
export async function createConnection(
  meId: string,
  targetUserId: string,
  message?: string,
): Promise<WireConnection[]> {
  const sql = await getSql();
  if (targetUserId === meId) throw new WireApiError("You can't add yourself.", "invalid_target");
  const me = await loadUserRow(sql, meId);
  if (isRemoteRow(me)) return remoteCreateConnection(meId, targetUserId, message);

  const target = await sql<WireUserRow>`select * from wire_users where id = ${targetUserId}`;
  if (!target[0] || target[0].status === "deleted") {
    throw new WireApiError("That account no longer exists.", "not_found", 404);
  }

  const incoming = await sql<{ status: string }>`
    select status from wire_connections
    where from_user = ${targetUserId} and to_user = ${meId}`;

  if (incoming[0]?.status === "blocked") {
    throw new WireApiError("You can't connect with this account.", "blocked", 403);
  }

  if (incoming[0]?.status === "pending") {
    // Their request to me + my request to them -> both accepted (Wire's rule).
    await sql`
      update wire_connections set status = 'accepted', updated_at = now()
      where (from_user = ${meId} and to_user = ${targetUserId})
         or (from_user = ${targetUserId} and to_user = ${meId})`;
  } else if (incoming[0]?.status === "accepted") {
    await sql`
      insert into wire_connections (from_user, to_user, status, message)
      values (${meId}, ${targetUserId}, 'accepted', ${message ?? null})
      on conflict (from_user, to_user)
        do update set status = 'accepted', updated_at = now()`;
  } else {
    await sql`
      insert into wire_connections (from_user, to_user, status, message)
      values (${meId}, ${targetUserId}, 'pending', ${message ?? null})
      on conflict (from_user, to_user)
        do update set status = 'pending', message = excluded.message, updated_at = now()`;
  }
  return listConnections(meId);
}

/**
 * `PUT /connections/{id}` — act on a request:
 * `accept` | `ignore` | `block` | `cancel`.
 */
export async function updateConnection(
  meId: string,
  peerUserId: string,
  action: "accept" | "ignore" | "block" | "cancel",
): Promise<WireConnection[]> {
  const sql = await getSql();
  if (peerUserId === meId) throw new WireApiError("Invalid contact.", "invalid_target");
  const me = await loadUserRow(sql, meId);
  if (isRemoteRow(me)) return remoteUpdateConnection(meId, peerUserId, action);

  const exists = await sql<{ id: string }>`select id from wire_users where id = ${peerUserId}`;
  if (!exists[0]) throw new WireApiError("That account no longer exists.", "not_found", 404);

  if (action === "accept") {
    // Accept the incoming request; ensure my side exists in accepted state.
    await sql`
      insert into wire_connections (from_user, to_user, status)
      values (${peerUserId}, ${meId}, 'accepted')
      on conflict (from_user, to_user)
        do update set status = 'accepted', updated_at = now()`;
    await sql`
      insert into wire_connections (from_user, to_user, status)
      values (${meId}, ${peerUserId}, 'accepted')
      on conflict (from_user, to_user)
        do update set status = 'accepted', updated_at = now()`;
  } else if (action === "block") {
    // Blocking replaces the pair with a single blocked edge from me.
    await sql`delete from wire_connections where from_user = ${peerUserId} and to_user = ${meId}`;
    await sql`
      insert into wire_connections (from_user, to_user, status)
      values (${meId}, ${peerUserId}, 'blocked')
      on conflict (from_user, to_user)
        do update set status = 'blocked', updated_at = now()`;
  } else if (action === "ignore") {
    await sql`
      update wire_connections set status = 'ignored', updated_at = now()
      where from_user = ${peerUserId} and to_user = ${meId}`;
    await sql`delete from wire_connections where from_user = ${meId} and to_user = ${peerUserId}`;
  } else {
    await sql`delete from wire_connections where from_user = ${meId} and to_user = ${peerUserId}`;
  }
  return listConnections(meId);
}

/** True when the two accounts are accepted contacts (gate for conversations). */
export async function areConnected(sql: Sql, a: string, b: string): Promise<boolean> {
  const rows = await sql<{ one: boolean; two: boolean }>`
    select
      exists(select 1 from wire_connections
             where from_user = ${a} and to_user = ${b} and status = 'accepted') as one,
      exists(select 1 from wire_connections
             where from_user = ${b} and to_user = ${a} and status = 'accepted') as two`;
  return Boolean(rows[0]?.one && rows[0]?.two);
}

/** Masking helper kept exported for consistent directory formatting. */
export { maskEmail, normalizeHandle };
