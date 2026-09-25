/**
 * Wire-shaped types shared by the client and the server functions.
 *
 * Field names follow Wire's public API (users, connections, conversations,
 * key packages, `access_token` / `refresh_token`), so the fork keeps Wire's
 * vocabulary end to end.
 */

/** Wire's connection states (brig `Connection`). */
export type WireConnectionStatus =
  | "pending"
  | "accepted"
  | "ignored"
  | "blocked"
  | "cancelled";

/** A directory entry. `email` is masked for anyone but accepted contacts. */
export interface WireUser {
  id: string;
  handle: string;
  name: string;
  email: string;
  accentId: number;
  locale: string;
  /** ISO timestamp. */
  createdAt: string;
  /** Device fingerprint of the user's active MLS client, when known. */
  fingerprint?: string | null;
  self?: boolean;
  /** My relationship to this user (omitted on raw lookups). */
  connectionStatus?: WireConnectionStatus | "none";
}

/** The signed-in account (`GET /self`). */
export interface WireSessionUser extends WireUser {
  emailVerified: boolean;
  status: "active" | "pending" | "deleted";
}

/** Token pair returned by `POST /login` and `POST /access`. */
export interface WireTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms at which the access token stops being accepted. */
  expiresAt: number;
  tokenType: "Bearer";
}

/** Everything the client keeps for a signed-in Wire account. */
export interface WireSession {
  user: WireSessionUser;
  tokens: WireTokens;
  /** The MLS client (device) registered for this browser. */
  clientId: string | null;
}

/** One row of `GET /connections`, resolved against the peer. */
export interface WireConnection {
  peer: WireUser;
  status: WireConnectionStatus;
  message: string | null;
  /** `incoming` when the peer requested it, `outgoing` when I did. */
  direction: "incoming" | "outgoing";
  updatedAt: string;
}

/** A registered device (`POST /clients`). */
export interface WireClientInfo {
  id: string;
  userId: string;
  type: "permanent" | "hidden";
  label: string;
  model: string;
  class: string;
  createdAt: string;
}

/** The public part of an MLS key package, signed by the device identity key. */
export interface WireKeyPackageBody {
  v: 1;
  /** Stable digest of the package contents (single-use reference). */
  ref: string;
  cipherSuite: string;
  clientId: string;
  /** ECDH P-256 init key (JWK) used to seal the welcome message. */
  initKey: JsonWebKey;
  /** ECDSA P-256 device identity key (JWK). */
  signingKey: JsonWebKey;
  /** Base64 ECDSA signature over the canonical package contents. */
  signature: string;
  /**
   * Random per-package salt (canonicalized + signed). Keeps every package's
   * `ref` digest unique so a device's upload batch never collides with itself.
   * Absent on packages minted before the salt existed — still verifiable.
   */
  nonce?: string;
}

export interface WireKeyPackage {
  id: string;
  userId: string;
  clientId: string;
  data: WireKeyPackageBody;
}

export interface WireConversationMember {
  userId: string;
  role: "admin" | "member";
}

/** A conversation (`POST /conversations`) — always MLS-encrypted. */
export interface WireConversation {
  id: string;
  type: "one2one" | "group";
  creator: string;
  name: string | null;
  protocol: "mls";
  epoch: number;
  createdAt: string;
  members: WireConversationMember[];
}

/** Stored ciphertext of an MLS application message. */
export interface WireMessageRow {
  id: string;
  conversationId: string;
  sender: string;
  senderClient: string;
  epoch: number;
  contentType: string;
  payload: string;
  createdAt: string;
}

/** A pending MLS welcome sealed to one of my clients. */
export interface WireWelcomeRow {
  id: string;
  conversationId: string;
  recipientUser: string;
  recipientClient: string;
  sender: string;
  epoch: number;
  payload: string;
  createdAt: string;
}

/** Result of `POST /register` — Wire asks for an email activation code. */
export type WireRegisterResult =
  | {
      ok: true;
      user: WireSessionUser;
      activation: { delivery: "email" | "in-app"; code?: string };
    }
  | { ok: false; code: "email_taken" | "handle_taken" | "invalid"; error: string };

/** Result of credential endpoints that can fail without being a server fault. */
export type WireAuthResult =
  | { ok: true; session: WireSession }
  | {
      ok: false;
      code: "invalid_credentials" | "needs_activation" | "bad_code" | "expired";
      error: string;
    };

/** Credential input for `POST /register`. */
export interface WireRegisterInput {
  name: string;
  email: string;
  password: string;
  /** Optional requested handle; derived from the email when absent. */
  handle?: string;
}

/** Credential input for `POST /login`. */
export interface WireLoginInput {
  email: string;
  password: string;
}

/** Result of step 1 of "forgot sign-in details?" — send the reset code. */
export type WireRecoverRequestResult =
  | {
      ok: true;
      /** `wire` = the code comes from wire.com's own email to this account. */
      delivery: "email" | "in-app" | "wire";
      /** Present only in the in-app demo inbox (no mail provider configured). */
      code?: string;
    }
  | { ok: false; error: string };

/** Result of step 2 — the code verified and the new password stored. */
export type WireRecoverConfirmResult = { ok: true } | { ok: false; error: string };

/** Identity payload encrypted inside every MLS application message. */
export interface WirePlaintext {
  v: 1;
  type: "text" | "knock" | "system";
  body: string;
  at: number;
  sender: { user: string; client: string };
}

/** A welcome envelope sealed to one recipient's key package init key. */
export interface WireWelcomeEnvelope {
  v: 1;
  /** Ephemeral ECDH P-256 public key (JWK) used for the seal. */
  epk: JsonWebKey;
  iv: string;
  ct: string;
  /** Domain-separation label bound into the AAD and the HKDF info. */
  info: string;
}
