/**
 * Wire-compatible messaging backend (galley): conversations, MLS welcome
 * deliveries and application messages.
 *
 * The server only ever sees ciphertext — payloads are opaque MLS envelopes and
 * the epoch secret is sealed to the recipient device's key package key.
 *
 * Server-only. Reached through `./api`.
 */
import { getSql, type Sql } from "@/lib/db";
import { WireApiError, uuid } from "./core.server";
import { areConnected } from "./social.server";
import type {
  WireConversation,
  WireConversationMember,
  WireMessageRow,
  WireWelcomeRow,
} from "./types";

interface ConversationRow {
  id: string;
  type: "one2one" | "group";
  creator: string;
  name: string | null;
  protocol: "mls";
  epoch: number;
  created_at: string | Date;
}

/** True when the user is a member of the conversation. */
async function isMember(sql: Sql, conversationId: string, userId: string): Promise<boolean> {
  const rows = await sql<{ one: boolean }>`
    select exists(
      select 1 from wire_conversation_members
      where conversation_id = ${conversationId} and user_id = ${userId}
    ) as one`;
  return Boolean(rows[0]?.one);
}

async function membersOf(sql: Sql, conversationId: string): Promise<WireConversationMember[]> {
  const rows = await sql<{ user_id: string; role: string }>`
    select user_id, role from wire_conversation_members
    where conversation_id = ${conversationId}`;
  return rows.map((r) => ({
    userId: r.user_id,
    role: r.role === "admin" ? "admin" : "member",
  }));
}

function toConversation(row: ConversationRow, members: WireConversationMember[]): WireConversation {
  return {
    id: row.id,
    type: row.type,
    creator: row.creator,
    name: row.name,
    protocol: row.protocol,
    epoch: Number(row.epoch),
    createdAt: new Date(row.created_at).toISOString(),
    members,
  };
}

/** Load one conversation with members, or throw 404. */
async function loadConversation(sql: Sql, conversationId: string): Promise<WireConversation> {
  const rows = await sql<ConversationRow>`
    select * from wire_conversations where id = ${conversationId}`;
  const row = rows[0];
  if (!row) throw new WireApiError("Conversation not found.", "not_found", 404);
  return toConversation(row, await membersOf(sql, conversationId));
}

/** `GET /conversations` — every conversation I'm a member of. */
export async function listConversations(meId: string): Promise<WireConversation[]> {
  const sql = await getSql();
  const rows = await sql<ConversationRow>`
    select c.* from wire_conversations c
    join wire_conversation_members m on m.conversation_id = c.id
    where m.user_id = ${meId}
    order by c.created_at asc`;
  const out: WireConversation[] = [];
  for (const row of rows) {
    out.push(toConversation(row, await membersOf(sql, row.id)));
  }
  return out;
}

/**
 * `POST /conversations` — start a conversation.
 *
 * Wire requires an accepted connection first; the 1:1 case is idempotent
 * (both sides resolve to the same conversation, so only its creator mints the
 * epoch and posts welcomes).
 */
export async function createConversation(
  meId: string,
  otherUserIds: string[],
  name?: string,
): Promise<WireConversation> {
  const sql = await getSql();
  // wire.com-mirrored accounts can sync contacts but not chat yet: the MLS
  // stacks are not interoperable, so refuse clearly instead of half-working.
  const me = await sql<{ remote_host: string | null }>`
    select remote_host from wire_users where id = ${meId}`;
  if (me[0]?.remote_host) {
    throw new WireApiError(
      "Chats with wire.com contacts aren't part of this build — messaging stays in your local vault channels. Contacts synced from wire.com are read-only.",
      "remote_messaging",
      403,
    );
  }
  const others = [...new Set(otherUserIds.filter((id) => id && id !== meId))];
  if (others.length === 0) throw new WireApiError("Pick at least one contact.", "no_targets");

  for (const other of others) {
    if (!(await areConnected(sql, meId, other))) {
      throw new WireApiError(
        "You can only message accepted connections. Send a contact request first.",
        "not_connected",
        403,
      );
    }
  }

  if (others.length === 1) {
    // Existing 1:1 between exactly these two accounts? Both sides must land on
    // the same conversation id so only one epoch/welcome flow is ever created.
    const existing = await sql.query<ConversationRow>(
      `select c.* from wire_conversations c
        where c.type = 'one2one'
          and exists (select 1 from wire_conversation_members m
                      where m.conversation_id = c.id and m.user_id = $1)
          and exists (select 1 from wire_conversation_members m
                      where m.conversation_id = c.id and m.user_id = $2)
          and (select count(*) from wire_conversation_members m
               where m.conversation_id = c.id) = 2
        limit 1`,
      [meId, others[0]],
    );
    if (existing[0]) return loadConversation(sql, existing[0].id);
  }

  const conversationId = uuid();
  await sql`
    insert into wire_conversations (id, type, creator, name, protocol, epoch)
    values (${conversationId}, ${others.length === 1 ? "one2one" : "group"},
            ${meId}, ${name ?? null}, 'mls', 0)`;
  await sql`
    insert into wire_conversation_members (conversation_id, user_id, role)
    values (${conversationId}, ${meId}, 'admin')`;
  for (const other of others) {
    await sql`
      insert into wire_conversation_members (conversation_id, user_id, role)
      values (${conversationId}, ${other}, 'member')
      on conflict do nothing`;
  }
  return loadConversation(sql, conversationId);
}

/** `POST /conversations/{id}/otr/welcome` — deliver sealed epoch secrets. */
export async function postWelcomes(
  meId: string,
  input: {
    conversationId: string;
    epoch: number;
    recipients: { userId: string; clientId: string; payload: string }[];
  },
): Promise<{ delivered: number }> {
  const sql = await getSql();
  if (!(await isMember(sql, input.conversationId, meId))) {
    throw new WireApiError("You're not a member of this conversation.", "forbidden", 403);
  }
  let delivered = 0;
  for (const recipient of input.recipients) {
    await sql`
      insert into wire_welcomes
        (id, conversation_id, recipient_user, recipient_client, sender, epoch, payload)
      values (${uuid()}, ${input.conversationId}, ${recipient.userId},
              ${recipient.clientId}, ${meId}, ${input.epoch}, ${recipient.payload})`;
    delivered += 1;
  }
  if (input.epoch > 0) {
    await sql`
      update wire_conversations set epoch = ${input.epoch} where id = ${input.conversationId}`;
  }
  return { delivered };
}

/** `GET /otr/welcome` — welcomes waiting for my devices. */
export async function fetchWelcomes(meId: string): Promise<WireWelcomeRow[]> {
  const sql = await getSql();
  const rows = await sql<{
    id: string;
    conversation_id: string;
    recipient_user: string;
    recipient_client: string;
    sender: string;
    epoch: number;
    payload: string;
    created_at: string | Date;
  }>`
    select * from wire_welcomes
     where recipient_user = ${meId}
     order by created_at desc
     limit 50`;
  return rows.map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    recipientUser: r.recipient_user,
    recipientClient: r.recipient_client,
    sender: r.sender,
    epoch: Number(r.epoch),
    payload: r.payload,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

/** `POST /conversations/{id}/otr/messages` — store one encrypted message. */
export async function postMessage(
  meId: string,
  input: {
    id: string;
    conversationId: string;
    senderClient: string;
    epoch: number;
    contentType?: string;
    payload: string;
  },
): Promise<WireMessageRow> {
  const sql = await getSql();
  if (!(await isMember(sql, input.conversationId, meId))) {
    throw new WireApiError("You're not a member of this conversation.", "forbidden", 403);
  }
  const client = await sql<{ id: string }>`
    select id from wire_clients where id = ${input.senderClient} and user_id = ${meId}`;
  if (!client[0]) {
    throw new WireApiError("This device isn't registered — sync your keys.", "device_missing", 409);
  }
  const message: WireMessageRow = {
    id: input.id || uuid(),
    conversationId: input.conversationId,
    sender: meId,
    senderClient: input.senderClient,
    epoch: input.epoch,
    contentType: input.contentType ?? "text/mls",
    payload: input.payload,
    createdAt: new Date().toISOString(),
  };
  await sql`
    insert into wire_messages
      (id, conversation_id, sender, sender_client, epoch, content_type, payload, created_at)
    values (${message.id}, ${message.conversationId}, ${message.sender},
            ${message.senderClient}, ${message.epoch}, ${message.contentType},
            ${message.payload}, ${message.createdAt})`;
  return message;
}

/**
 * `GET /conversations/{id}/messages` — ciphertext for a conversation I'm a
 * member of, optionally since a timestamp (`>=` so nothing is skipped; the
 * client de-duplicates by id).
 */
export async function fetchMessages(
  meId: string,
  input: { conversationId: string; since?: string | null; limit?: number },
): Promise<WireMessageRow[]> {
  const sql = await getSql();
  if (!(await isMember(sql, input.conversationId, meId))) {
    throw new WireApiError("You're not a member of this conversation.", "forbidden", 403);
  }
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 200);
  const since = input.since ?? null;
  type Row = {
    id: string;
    conversation_id: string;
    sender: string;
    sender_client: string;
    epoch: number;
    content_type: string;
    payload: string;
    created_at: string | Date;
  };
  const rows = since
    ? await sql.query<Row>(
        `select * from wire_messages
          where conversation_id = $1 and created_at >= $2
          order by created_at asc limit $3`,
        [input.conversationId, since, limit],
      )
    : await sql.query<Row>(
        `select * from wire_messages
          where conversation_id = $1
          order by created_at asc limit $2`,
        [input.conversationId, limit],
      );
  return rows.map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    sender: r.sender,
    senderClient: r.sender_client,
    epoch: Number(r.epoch),
    contentType: r.content_type,
    payload: r.payload,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}
