export type ConversationKind = "direct" | "group" | "dead-drop" | "live";
export type MessageKind = "text" | "system" | "dead-drop" | "knock" | "file";
export type TtlHours = 0 | 1 | 24 | 72;
export type RailView = "inbox" | "people" | "live" | "drops" | "archive" | "vault";
export type AppPhase = "boot" | "onboarding" | "locked" | "ready";
export type CallState = {
  conversationId: string;
  mode: "audio" | "video";
  status: "ringing" | "active";
  startedAt: number;
} | null;

export interface DeviceInfo {
  id: string;
  label: string;
  platform: string;
  current?: boolean;
  verified: boolean;
  lastSeenAgo: string;
}

export interface Participant {
  id: string;
  name: string;
  fingerprint: string;
  verified: boolean;
  role?: "admin" | "member";
  hue: number;
}

export interface Conversation {
  id: string;
  kind: ConversationKind;
  title: string;
  subtitle: string;
  hue: number;
  verified: boolean;
  muted: boolean;
  archived: boolean;
  pinned: boolean;
  unread: number;
  ttlHours: TtlHours;
  lastAt: number;
  lastPreview: string;
  members: Participant[];
  roomCode?: string;
  livePeers?: number;
  knocked?: boolean;
  /** True when the id is a Wire backend conversation (MLS, ciphertext at rest). */
  wire?: boolean;
  /** The contact this 1:1 conversation belongs to. */
  peerId?: string;
  /** The contact's Wire handle (shown in MLS subtitles). */
  handle?: string;
}

export interface Message {
  id: string;
  conversationId: string;
  kind: MessageKind;
  fromId: string;
  fromName: string;
  body: string;
  at: number;
  ttlHours: TtlHours;
  expiresAt?: number;
  sealed?: boolean;
  consumed?: boolean;
  replyTo?: { id: string; body: string; fromName: string };
  fileName?: string;
  delivered?: boolean;
  reaction?: "ack" | "flag" | "hold" | null;
  mine?: boolean;
}

export interface Identity {
  id: string;
  callsign: string;
  fingerprint: string;
  createdAt: number;
}

export interface VaultSettings {
  screenshotShield: boolean;
  stealth: boolean;
  coverTraffic: boolean;
  readReceipts: boolean;
  defaultTtl: TtlHours;
  autoLockMinutes: 0 | 5 | 15;
}

/** Hostname of Wire's production backend used for the live link probe. */
export const WIRE_BACKEND_HOST = "prod-nginz-https.wire.com";

export type WireLinkPhase = "idle" | "connecting" | "online" | "offline";

export interface WireLinkProbe {
  ok: boolean;
  host: string;
  domain?: string;
  federation?: boolean;
  supported?: number[];
  latencyMs?: number;
  checkedAt: number;
  error?: string;
}

export interface WireLinkState {
  phase: WireLinkPhase;
  probe?: WireLinkProbe;
}

export interface VaultSnapshot {
  identity: Identity;
  conversations: Conversation[];
  messages: Record<string, Message[]>;
  settings: VaultSettings;
  pinSalt?: string;
  pinHash?: string;
  duressHash?: string;
}
