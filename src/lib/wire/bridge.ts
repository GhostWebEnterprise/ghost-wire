/**
 * Bridges Wire's conversation shape into the messenger's local `Conversation`
 * type, so MLS conversations render in the same list, chat pane and info panel
 * as the seeded local ones.
 *
 * Type-only imports on both sides: no store imports, so neither store can
 * create an import cycle with this module.
 */
import type { Conversation, Identity, Participant } from "@/lib/messenger/types";
import type { WireConnection, WireConversation, WireUser } from "./types";
import { isPeerVerified } from "./verified";

/** Stable avatar hue derived from a handle (keeps a contact's colour stable). */
export function hueFor(seed: string): number {
  let total = 0;
  for (let i = 0; i < seed.length; i++) total += seed.charCodeAt(i);
  return total % 6;
}

export interface VaultConversationInput {
  conversation: WireConversation;
  identity: Identity | null;
  meId: string;
  /** The peer profile, when the caller already knows it (contacts panel). */
  peer?: WireUser;
  /** Otherwise resolve the peer from my accepted connections. */
  connections?: WireConnection[];
}

/**
 * Build the local `Conversation` for a Wire MLS conversation: direct kind,
 * no local TTL (the backend keeps the ciphertext), MLS subtitle with the
 * current epoch, and members carrying their device fingerprints.
 */
export function toVaultConversation(input: VaultConversationInput): Conversation {
  const { conversation, identity, meId } = input;
  const member = conversation.members.find((m) => m.userId !== meId);
  const peerId = member?.userId ?? input.peer?.id;
  const peer =
    input.peer ??
    (peerId ? input.connections?.find((c) => c.peer.id === peerId)?.peer : undefined) ??
    null;
  const handle = peer?.handle ?? "wire";
  const verified = peerId ? isPeerVerified(peerId) : false;

  const participants: Participant[] = [];
  if (identity) {
    participants.push({
      id: identity.id,
      name: identity.callsign,
      fingerprint: identity.fingerprint,
      verified: true,
      hue: 0,
      role: "admin",
    });
  }
  if (peerId) {
    participants.push({
      id: peerId,
      name: peer?.name ?? "Contact",
      fingerprint: peer?.fingerprint ?? "Awaiting key package",
      verified,
      hue: hueFor(handle),
      role: "member",
    });
  }

  return {
    id: conversation.id,
    kind: "direct",
    title: peer?.name ?? "Contact",
    subtitle: `MLS · @${handle} · epoch ${conversation.epoch}`,
    hue: hueFor(handle),
    verified,
    muted: false,
    archived: false,
    pinned: false,
    unread: 0,
    ttlHours: 0,
    lastAt: Date.parse(conversation.createdAt) || Date.now(),
    lastPreview: "MLS session established",
    members: participants,
    wire: true,
    peerId,
    handle,
  };
}
