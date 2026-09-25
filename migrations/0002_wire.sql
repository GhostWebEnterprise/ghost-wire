-- Wire-compatible account, contact and messaging schema for this fork.
--
-- Mirrors the structure of Wire's backend services so the client speaks Wire's
-- data model end to end:
--   brig  -> wire_users, wire_clients, wire_key_packages, wire_sessions,
--            wire_connections (contacts)
--   galley-> wire_conversations, wire_conversation_members, wire_messages,
--            wire_welcomes (MLS welcome deliveries)
--
-- Ids are text UUIDs generated application-side (no pgcrypto dependency, and
-- identical ids on Neon and PGLite). Nothing here stores plaintext: passwords
-- are scrypt hashes, sessions store sha256 token hashes, messages and welcomes
-- are opaque MLS ciphertext.

create table if not exists wire_users (
  id                 text primary key,
  handle             text not null unique,
  email              text not null unique,
  email_verified     boolean not null default false,
  activation_code    text,
  activation_expires timestamptz,
  password_hash      text not null,
  name               text not null,
  accent_id          integer not null default 1,
  locale             text not null default 'en',
  -- Wire's account states: active | pending (awaiting activation) | deleted
  status             text not null default 'active',
  assets             jsonb not null default '[]'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists wire_clients (
  id                text primary key,
  user_id           text not null references wire_users(id) on delete cascade,
  -- Wire client classes: permanent devices register MLS key packages
  type              text not null default 'permanent',
  label             text not null default '',
  model             text not null default '',
  class             text not null default 'desktop',
  last_key_package  timestamptz,
  created_at        timestamptz not null default now()
);
create index if not exists wire_clients_user_idx on wire_clients (user_id);

-- Single-use MLS key packages (Wire: POST /mls/key-packages), claimed when a
-- peer starts a conversation with this device.
create table if not exists wire_key_packages (
  id         text primary key,
  user_id    text not null references wire_users(id) on delete cascade,
  client_id  text not null references wire_clients(id) on delete cascade,
  data       jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists wire_key_packages_claim_idx
  on wire_key_packages (user_id, created_at desc);

-- Opaque access/refresh tokens (Wire: POST /login -> {access_token,
-- refresh_token, expires_in, token_type}). Only sha256 hashes are stored.
create table if not exists wire_sessions (
  id                 text primary key,
  user_id            text not null references wire_users(id) on delete cascade,
  client_id          text,
  access_hash        text not null unique,
  refresh_hash       text not null unique,
  access_expires_at  timestamptz not null,
  refresh_expires_at timestamptz not null,
  created_at         timestamptz not null default now()
);
create index if not exists wire_sessions_user_idx on wire_sessions (user_id);

-- Contacts (Wire: POST /connections, PUT /connections/{id}).
-- A connection row exists in one direction with one of Wire's statuses.
create table if not exists wire_connections (
  from_user  text not null references wire_users(id) on delete cascade,
  to_user    text not null references wire_users(id) on delete cascade,
  status     text not null default 'pending',
  message    text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (from_user, to_user),
  check (from_user <> to_user)
);
create index if not exists wire_connections_to_idx on wire_connections (to_user, status);
create index if not exists wire_connections_from_idx on wire_connections (from_user, status);

create table if not exists wire_conversations (
  id        text primary key,
  type      text not null default 'one2one',
  creator   text not null references wire_users(id),
  name      text,
  -- MLS is the default protocol; epochs bump when the group key rotates
  protocol  text not null default 'mls',
  epoch     bigint not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists wire_conversation_members (
  conversation_id text not null references wire_conversations(id) on delete cascade,
  user_id         text not null references wire_users(id) on delete cascade,
  role            text not null default 'member',
  hidden          boolean not null default false,
  muted           boolean not null default false,
  archived        boolean not null default false,
  last_read       text,
  primary key (conversation_id, user_id)
);

-- MLS application messages: opaque ciphertext only, never plaintext.
create table if not exists wire_messages (
  id              text primary key,
  conversation_id text not null references wire_conversations(id) on delete cascade,
  sender          text not null references wire_users(id),
  sender_client   text not null,
  epoch           bigint not null default 0,
  content_type    text not null default 'text/mls',
  payload         text not null,
  created_at      timestamptz not null default now()
);
create index if not exists wire_messages_conv_idx
  on wire_messages (conversation_id, created_at, id);

-- MLS welcome messages: the group epoch secret, sealed to a recipient device's
-- key package public key (Wire: POST /conversations/{id}/otr/welcome).
create table if not exists wire_welcomes (
  id               text primary key,
  conversation_id  text not null references wire_conversations(id) on delete cascade,
  recipient_user   text not null references wire_users(id) on delete cascade,
  recipient_client text not null,
  sender           text not null references wire_users(id),
  epoch            bigint not null default 0,
  payload          text not null,
  created_at       timestamptz not null default now()
);
create index if not exists wire_welcomes_recipient_idx
  on wire_welcomes (recipient_user, created_at desc);
