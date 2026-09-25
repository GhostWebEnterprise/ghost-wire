import { create } from "zustand";
import type {
  AppPhase,
  CallState,
  Conversation,
  Identity,
  Message,
  MessageKind,
  RailView,
  TtlHours,
  VaultSettings,
  VaultSnapshot,
  WireLinkState,
} from "./types";
import { WIRE_BACKEND_HOST } from "./types";
import {
  displayCode,
  generateIdentity,
  generateInviteCode,
  pinHash,
  randomId,
  roomIdFromCode,
  unwrapJson,
  wrapJson,
} from "./crypto";
import { buildSeed, defaultSettings } from "./seed";
import { importEpochs } from "@/lib/wire/mls";
import type { VaultBackupPayload } from "./backup";

const META_KEY = "ghostwire-meta-v1";
const VAULT_KEY = "ghostwire-vault-v1";

type Meta = {
  sealed: boolean;
  hasPin: boolean;
  salt?: string;
  pinHash?: string;
  duressHash?: string;
};

const livePipes = new Map<string, (payload: unknown) => void>();

export function registerLivePipe(conversationId: string, send: (payload: unknown) => void) {
  livePipes.set(conversationId, send);
  return () => {
    livePipes.delete(conversationId);
  };
}

function readMeta(): Meta | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(META_KEY);
    return raw ? (JSON.parse(raw) as Meta) : null;
  } catch {
    return null;
  }
}

function writeMeta(meta: Meta) {
  localStorage.setItem(META_KEY, JSON.stringify(meta));
}

export interface SendDraft {
  body: string;
  kind?: MessageKind;
  ttlHours?: TtlHours;
  replyTo?: Message["replyTo"];
  fileName?: string;
}

interface VaultState {
  phase: AppPhase;
  identity: Identity | null;
  conversations: Conversation[];
  messages: Record<string, Message[]>;
  settings: VaultSettings;
  activeId: string | null;
  rail: RailView;
  query: string;
  infoOpen: boolean;
  call: CallState;
  busy: boolean;
  error: string | null;
  hasPin: boolean;
  wire: WireLinkState;
  boot: () => void;
  connectWire: () => Promise<void>;
  completeOnboarding: (callsign: string, pin?: string, duress?: string) => Promise<void>;
  unlock: (pin: string) => Promise<"ok" | "duress" | "bad">;
  lock: () => Promise<void>;
  wipe: () => void;
  /**
   * Merge a decrypted backup file (`./backup`) into the live vault: missing
   * conversations, messages and MLS epoch keys are added, existing local data
   * and device settings/PIN stay untouched. Returns what was added.
   */
  restoreBackup: (
    payload: VaultBackupPayload,
  ) => Promise<{ conversations: number; messages: number; epochs: number }>;
  setRail: (rail: RailView) => void;
  addWireConversation: (conversation: Conversation) => void;
  setActive: (id: string | null) => void;
  setQuery: (q: string) => void;
  setInfoOpen: (open: boolean) => void;
  sendMessage: (conversationId: string, draft: SendDraft) => Promise<void>;
  ingestRemote: (conversationId: string, message: Message) => void;
  openDeadDrop: (conversationId: string, messageId: string) => void;
  react: (conversationId: string, messageId: string, reaction: Message["reaction"]) => void;
  knock: (conversationId: string) => void;
  verifyContact: (conversationId: string) => void;
  setTtl: (conversationId: string, ttlHours: TtlHours) => void;
  toggleMute: (conversationId: string) => void;
  archive: (conversationId: string, archived?: boolean) => void;
  updateSettings: (patch: Partial<VaultSettings>) => void;
  setPin: (pin: string, duress?: string) => Promise<void>;
  createLive: () => Conversation;
  joinLive: (code: string) => Conversation | null;
  setLivePeers: (conversationId: string, count: number) => void;
  startCall: (conversationId: string, mode: "audio" | "video") => void;
  endCall: () => void;
  purgeExpired: () => void;
  rename: (callsign: string) => void;
}

function snapshotOf(state: VaultState): VaultSnapshot {
  return {
    identity: state.identity!,
    conversations: state.conversations,
    messages: state.messages,
    settings: state.settings,
  };
}

async function persist(state: VaultState, pin?: string) {
  if (!state.identity) return;
  const snap = snapshotOf(state);
  const meta = readMeta();
  if (pin || meta?.hasPin) {
    const usedPin = pin;
    if (!usedPin) return;
    const blob = await wrapJson(usedPin, snap);
    localStorage.setItem(VAULT_KEY, blob);
    writeMeta({
      sealed: true,
      hasPin: true,
      salt: meta?.salt,
      pinHash: meta?.pinHash,
      duressHash: meta?.duressHash,
    });
  } else {
    localStorage.setItem(VAULT_KEY, JSON.stringify(snap));
    writeMeta({ sealed: false, hasPin: false });
  }
}

let persistPin: string | null = null;

export const useVault = create<VaultState>((set, get) => ({
  phase: "boot",
  identity: null,
  conversations: [],
  messages: {},
  settings: defaultSettings(),
  activeId: null,
  rail: "inbox",
  query: "",
  infoOpen: false,
  call: null,
  busy: false,
  error: null,
  hasPin: false,
  wire: { phase: "idle" },

  connectWire: async () => {
    set({ wire: { ...get().wire, phase: "connecting" } });
    try {
      const res = await fetch("/api/wire", { cache: "no-store" });
      const probe = (await res.json()) as WireLinkState["probe"];
      set({ wire: { phase: probe?.ok ? "online" : "offline", probe } });
    } catch (err) {
      set({
        wire: {
          phase: "offline",
          probe: {
            ok: false,
            host: WIRE_BACKEND_HOST,
            checkedAt: Date.now(),
            error: err instanceof Error ? err.message : "unreachable",
          },
        },
      });
    }
  },

  boot: () => {
    const meta = readMeta();
    if (!meta) {
      set({ phase: "onboarding", hasPin: false });
      return;
    }
    if (meta.sealed) {
      set({ phase: "locked", hasPin: true });
      return;
    }
    try {
      const raw = localStorage.getItem(VAULT_KEY);
      if (!raw) {
        set({ phase: "onboarding" });
        return;
      }
      const snap = JSON.parse(raw) as VaultSnapshot;
      set({
        phase: "ready",
        identity: snap.identity,
        conversations: snap.conversations,
        messages: snap.messages,
        settings: { ...defaultSettings(), ...snap.settings },
        activeId: snap.conversations.find((c) => !c.archived)?.id ?? null,
        hasPin: false,
      });
    } catch {
      set({ phase: "onboarding" });
    }
  },

  completeOnboarding: async (callsign, pin, duress) => {
    set({ busy: true, error: null });
    try {
      const keys = await generateIdentity();
      const identity: Identity = {
        id: keys.id,
        callsign: callsign.trim() || "Operator",
        fingerprint: keys.fingerprint,
        createdAt: Date.now(),
      };
      const seeded = buildSeed(identity);
      let meta: Meta = { sealed: false, hasPin: false };
      if (pin) {
        const hashed = await pinHash(pin);
        let duressHash: string | undefined;
        if (duress) {
          const d = await pinHash(duress, hashed.salt);
          duressHash = d.hash;
        }
        meta = { sealed: true, hasPin: true, salt: hashed.salt, pinHash: hashed.hash, duressHash };
        persistPin = pin;
      }
      writeMeta(meta);
      set({
        phase: "ready",
        identity,
        conversations: seeded.conversations,
        messages: seeded.messages,
        settings: defaultSettings(),
        activeId: "c-ops",
        hasPin: Boolean(pin),
        busy: false,
      });
      await persist(get(), pin);
    } catch (err) {
      set({ busy: false, error: err instanceof Error ? err.message : "Vault setup failed" });
    }
  },

  unlock: async (pin) => {
    const meta = readMeta();
    if (!meta?.salt || !meta.pinHash) return "bad";
    const hashed = await pinHash(pin, meta.salt);
    if (meta.duressHash && hashed.hash === meta.duressHash) {
      get().wipe();
      return "duress";
    }
    if (hashed.hash !== meta.pinHash) return "bad";
    try {
      const raw = localStorage.getItem(VAULT_KEY);
      if (!raw) return "bad";
      const snap = await unwrapJson<VaultSnapshot>(pin, raw);
      persistPin = pin;
      set({
        phase: "ready",
        identity: snap.identity,
        conversations: snap.conversations,
        messages: snap.messages,
        settings: { ...defaultSettings(), ...snap.settings },
        activeId: snap.conversations.find((c) => !c.archived)?.id ?? null,
        hasPin: true,
        error: null,
      });
      return "ok";
    } catch {
      return "bad";
    }
  },

  lock: async () => {
    const state = get();
    if (state.hasPin && persistPin) await persist(state, persistPin);
    else await persist(state);
    persistPin = null;
    set({
      phase: state.hasPin ? "locked" : "ready",
      identity: state.hasPin ? null : state.identity,
      conversations: state.hasPin ? [] : state.conversations,
      messages: state.hasPin ? {} : state.messages,
      call: null,
    });
  },

  wipe: () => {
    persistPin = null;
    localStorage.removeItem(VAULT_KEY);
    localStorage.removeItem(META_KEY);
    set({
      phase: "onboarding",
      identity: null,
      conversations: [],
      messages: {},
      settings: defaultSettings(),
      activeId: null,
      call: null,
      hasPin: false,
      error: null,
    });
  },

  restoreBackup: async (payload) => {
    const state = get();

    // Conversations: additive merge — a backup can never clobber what this
    // device already has (the sync loop owns fresher Wire-side state).
    const known = new Set(state.conversations.map((c) => c.id));
    const restored: Conversation[] = [];
    for (const conversation of payload.conversations ?? []) {
      if (!conversation?.id || known.has(conversation.id)) continue;
      known.add(conversation.id);
      restored.push(conversation);
    }
    const conversations = [...state.conversations, ...restored];

    // Messages: union by id per conversation, re-sorted chronologically.
    const messages: Record<string, Message[]> = { ...state.messages };
    let restoredMessages = 0;
    for (const [conversationId, rows] of Object.entries(payload.messages ?? {})) {
      if (!Array.isArray(rows)) continue;
      const seen = new Set((messages[conversationId] ?? []).map((m) => m.id));
      const merged = [...(messages[conversationId] ?? [])];
      for (const row of rows) {
        if (!row?.id || seen.has(row.id)) continue;
        seen.add(row.id);
        merged.push(row);
        restoredMessages += 1;
      }
      if (merged.length) messages[conversationId] = merged.sort((a, b) => a.at - b.at);
    }

    // MLS epoch keys — without these the restored Wire ciphertext stays opaque.
    const epochs = importEpochs(payload.epochs);

    set({
      identity: payload.identity ?? state.identity,
      conversations,
      messages,
      activeId:
        state.activeId ?? conversations.find((c) => !c.archived)?.id ?? null,
    });
    await persist(get(), persistPin ?? undefined);
    return { conversations: restored.length, messages: restoredMessages, epochs };
  },

  setRail: (rail) => set({ rail, activeId: rail === "vault" ? get().activeId : get().activeId }),

  /** Add a Wire/MLS conversation once (idempotent — the sync loop re-offers it). */
  addWireConversation: (conversation) => {
    const exists = get().conversations.some((c) => c.id === conversation.id);
    if (exists) return;
    set((s) => ({ conversations: [conversation, ...s.conversations] }));
    void persist(get(), persistPin ?? undefined);
  },
  setActive: (id) => {
    if (!id) {
      set({ activeId: null, infoOpen: false });
      return;
    }
    set((s) => ({
      activeId: id,
      conversations: s.conversations.map((c) => (c.id === id ? { ...c, unread: 0, knocked: false } : c)),
    }));
  },
  setQuery: (query) => set({ query }),
  setInfoOpen: (infoOpen) => set({ infoOpen }),

  sendMessage: async (conversationId, draft) => {
    const state = get();
    const identity = state.identity;
    if (!identity || !draft.body.trim() && draft.kind !== "knock" && !draft.fileName) return;
    const conv = state.conversations.find((c) => c.id === conversationId);
    const ttl = draft.ttlHours ?? conv?.ttlHours ?? state.settings.defaultTtl;
    const kind: MessageKind = draft.kind ?? (draft.fileName ? "file" : "text");
    const now = Date.now();

    // Wire-backed conversations are sealed client-side: encrypt under the MLS
    // epoch key, post the ciphertext, then adopt the backend message id so the
    // next sync pass de-duplicates instead of double-rendering it. No epoch key
    // (or a rejected post) means nothing was delivered — surface the error
    // rather than painting a message the peer will never see.
    let id = randomId("m");
    let at = now;
    const wireBody = draft.body.trim() || (draft.fileName ? `\u{1F4CE} ${draft.fileName}` : "");
    if (conv?.wire) {
      try {
        const { useWire } = await import("@/lib/wire/store");
        const sent = await useWire.getState().sendMlsMessage(
          conversationId,
          wireBody,
          kind === "knock" ? "knock" : "text",
        );
        id = sent.id;
        at = sent.at;
      } catch (err) {
        const { useWire } = await import("@/lib/wire/store");
        useWire.setState({
          error: err instanceof Error ? err.message : "Message could not be delivered.",
        });
        return;
      }
    }

    const message: Message = {
      id,
      conversationId,
      kind,
      fromId: identity.id,
      fromName: identity.callsign,
      body: kind === "dead-drop" ? "" : draft.body.trim() || wireBody,
      at,
      // MLS conversations keep their ciphertext on the backend with no local
      // expiry — only the local dead-drop/rich conversations self-destruct.
      ttlHours: conv?.wire ? 0 : ttl,
      expiresAt: conv?.wire ? undefined : ttl ? at + ttl * 60 * 60 * 1000 : undefined,
      sealed: kind === "dead-drop",
      consumed: kind === "dead-drop",
      replyTo: draft.replyTo,
      fileName: draft.fileName,
      delivered: true,
      mine: true,
    };
    const preview =
      kind === "dead-drop"
        ? "Dead drop sent · no copy retained"
        : kind === "knock"
          ? "Knock"
          : draft.body.trim() || draft.fileName || "";

    set((s) => ({
      messages: {
        ...s.messages,
        [conversationId]: [...(s.messages[conversationId] ?? []), message],
      },
      conversations: s.conversations.map((c) =>
        c.id === conversationId ? { ...c, lastAt: now, lastPreview: preview, unread: 0 } : c,
      ),
    }));

    const pipe = livePipes.get(conversationId);
    if (pipe) {
      pipe({
        type: "msg",
        message: {
          ...message,
          body: draft.body.trim(),
          mine: false,
          fromId: identity.id,
          fromName: identity.callsign,
        },
      });
    }
    void persist(get(), persistPin ?? undefined);
  },

  ingestRemote: (conversationId, message) => {
    set((s) => {
      const exists = (s.messages[conversationId] ?? []).some((m) => m.id === message.id);
      if (exists) return s;
      const conv = s.conversations.find((c) => c.id === conversationId);
      // Own messages come back down from the MLS sync pass too; they must not
      // count as unread or flip to the peer's bubble.
      const mine = message.mine ?? false;
      const unreadBump = mine || s.activeId === conversationId ? 0 : 1;
      return {
        messages: {
          ...s.messages,
          [conversationId]: [...(s.messages[conversationId] ?? []), { ...message, mine }],
        },
        conversations: s.conversations.map((c) =>
          c.id === conversationId
            ? {
                ...c,
                lastAt: message.at,
                lastPreview:
                  message.kind === "dead-drop"
                    ? "Sealed packet"
                    : message.kind === "knock"
                      ? "Knock"
                      : message.body,
                unread: c.unread + unreadBump,
                knocked: message.kind === "knock" ? true : c.knocked,
              }
            : c,
        ),
        activeId: conv ? s.activeId : s.activeId,
      };
    });
    void persist(get(), persistPin ?? undefined);
  },

  openDeadDrop: (conversationId, messageId) => {
    set((s) => ({
      messages: {
        ...s.messages,
        [conversationId]: (s.messages[conversationId] ?? []).map((m) =>
          m.id === messageId ? { ...m, sealed: false, consumed: true } : m,
        ),
      },
    }));
    window.setTimeout(() => {
      set((s) => ({
        messages: {
          ...s.messages,
          [conversationId]: (s.messages[conversationId] ?? []).map((m) =>
            m.id === messageId ? { ...m, body: "", sealed: false, consumed: true } : m,
          ),
        },
      }));
      void persist(get(), persistPin ?? undefined);
    }, 20_000);
  },

  react: (conversationId, messageId, reaction) => {
    set((s) => ({
      messages: {
        ...s.messages,
        [conversationId]: (s.messages[conversationId] ?? []).map((m) =>
          m.id === messageId ? { ...m, reaction: m.reaction === reaction ? null : reaction } : m,
        ),
      },
    }));
    void persist(get(), persistPin ?? undefined);
  },

  knock: (conversationId) => {
    void get().sendMessage(conversationId, { body: "Knock", kind: "knock" });
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === conversationId ? { ...c, knocked: true } : c)),
    }));
    window.setTimeout(() => {
      set((s) => ({
        conversations: s.conversations.map((c) => (c.id === conversationId ? { ...c, knocked: false } : c)),
      }));
    }, 900);
  },

  verifyContact: (conversationId) => {
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === conversationId
          ? {
              ...c,
              verified: true,
              subtitle: c.kind === "direct" ? "Verified · sealed" : c.subtitle,
              members: c.members.map((m) => ({ ...m, verified: true })),
            }
          : c,
      ),
    }));
    const identity = get().identity;
    if (identity) {
      const now = Date.now();
      const system: Message = {
        id: randomId("m"),
        conversationId,
        kind: "system",
        fromId: "system",
        fromName: "Vault",
        body: "Fingerprints matched · session sealed",
        at: now,
        ttlHours: 0,
        delivered: true,
      };
      set((s) => ({
        messages: {
          ...s.messages,
          [conversationId]: [...(s.messages[conversationId] ?? []), system],
        },
      }));
    }
    void persist(get(), persistPin ?? undefined);
  },

  setTtl: (conversationId, ttlHours) => {
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === conversationId ? { ...c, ttlHours } : c)),
    }));
    void persist(get(), persistPin ?? undefined);
  },

  toggleMute: (conversationId) => {
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === conversationId ? { ...c, muted: !c.muted } : c)),
    }));
    void persist(get(), persistPin ?? undefined);
  },

  archive: (conversationId, archived = true) => {
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === conversationId ? { ...c, archived } : c)),
      activeId: s.activeId === conversationId ? null : s.activeId,
    }));
    void persist(get(), persistPin ?? undefined);
  },

  updateSettings: (patch) => {
    set((s) => ({ settings: { ...s.settings, ...patch } }));
    void persist(get(), persistPin ?? undefined);
  },

  setPin: async (pin, duress) => {
    const hashed = await pinHash(pin);
    let duressHash: string | undefined;
    if (duress) {
      const d = await pinHash(duress, hashed.salt);
      duressHash = d.hash;
    }
    writeMeta({
      sealed: true,
      hasPin: true,
      salt: hashed.salt,
      pinHash: hashed.hash,
      duressHash,
    });
    persistPin = pin;
    set({ hasPin: true });
    await persist(get(), pin);
  },

  createLive: () => {
    const identity = get().identity;
    const code = generateInviteCode();
    const room = roomIdFromCode(code);
    const conv: Conversation = {
      id: `c-live-${room}`,
      kind: "live",
      title: "Sealed channel",
      subtitle: displayCode(code),
      hue: 4,
      verified: true,
      muted: false,
      archived: false,
      pinned: false,
      unread: 0,
      ttlHours: get().settings.defaultTtl,
      lastAt: Date.now(),
      lastPreview: "Waiting for peer",
      roomCode: displayCode(code),
      livePeers: 0,
      members: identity
        ? [
            {
              id: identity.id,
              name: identity.callsign,
              fingerprint: identity.fingerprint,
              verified: true,
              hue: 0,
            },
          ]
        : [],
    };
    const system: Message = {
      id: randomId("m"),
      conversationId: conv.id,
      kind: "system",
      fromId: "system",
      fromName: "Vault",
      body: `Invite ${displayCode(code)} · hybrid PQ ratchet · ciphertext never stored in plaintext`,
      at: Date.now(),
      ttlHours: 0,
      delivered: true,
    };
    set((s) => ({
      conversations: [conv, ...s.conversations],
      messages: { ...s.messages, [conv.id]: [system] },
      activeId: conv.id,
      rail: "live",
    }));
    void persist(get(), persistPin ?? undefined);
    return conv;
  },

  joinLive: (code) => {
    const room = roomIdFromCode(code);
    if (room.length < 6) return null;
    const existing = get().conversations.find((c) => c.id === `c-live-${room}`);
    if (existing) {
      set({ activeId: existing.id, rail: "live" });
      return existing;
    }
    const identity = get().identity;
    const conv: Conversation = {
      id: `c-live-${room}`,
      kind: "live",
      title: "Sealed channel",
      subtitle: displayCode(code),
      hue: 4,
      verified: true,
      muted: false,
      archived: false,
      pinned: false,
      unread: 0,
      ttlHours: get().settings.defaultTtl,
      lastAt: Date.now(),
      lastPreview: "Joining…",
      roomCode: displayCode(code),
      livePeers: 0,
      members: identity
        ? [
            {
              id: identity.id,
              name: identity.callsign,
              fingerprint: identity.fingerprint,
              verified: true,
              hue: 0,
            },
          ]
        : [],
    };
    const system: Message = {
      id: randomId("m"),
      conversationId: conv.id,
      kind: "system",
      fromId: "system",
      fromName: "Vault",
      body: `Joined ${displayCode(code)} · waiting for peer handshake`,
      at: Date.now(),
      ttlHours: 0,
      delivered: true,
    };
    set((s) => ({
      conversations: [conv, ...s.conversations],
      messages: { ...s.messages, [conv.id]: [system] },
      activeId: conv.id,
      rail: "live",
    }));
    void persist(get(), persistPin ?? undefined);
    return conv;
  },

  setLivePeers: (conversationId, count) => {
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === conversationId
          ? {
              ...c,
              livePeers: count,
              lastPreview: count > 0 ? `${count} peer${count === 1 ? "" : "s"} on channel` : "Waiting for peer",
            }
          : c,
      ),
    }));
  },

  startCall: (conversationId, mode) => {
    set({
      call: { conversationId, mode, status: "ringing", startedAt: Date.now() },
    });
    window.setTimeout(() => {
      const call = get().call;
      if (call && call.status === "ringing") {
        set({ call: { ...call, status: "active", startedAt: Date.now() } });
      }
    }, 1400);
  },
  endCall: () => set({ call: null }),

  purgeExpired: () => {
    const now = Date.now();
    set((s) => {
      let changed = false;
      const next: Record<string, Message[]> = {};
      for (const [id, list] of Object.entries(s.messages)) {
        const kept = list.filter((m) => !m.expiresAt || m.expiresAt > now);
        if (kept.length !== list.length) changed = true;
        next[id] = kept;
      }
      return changed ? { messages: next } : s;
    });
  },

  rename: (callsign) => {
    const name = callsign.trim();
    if (!name) return;
    set((s) =>
      s.identity
        ? {
            identity: { ...s.identity, callsign: name },
            conversations: s.conversations.map((c) => ({
              ...c,
              members: c.members.map((m) => (m.id === s.identity?.id ? { ...m, name } : m)),
            })),
          }
        : s,
    );
    void persist(get(), persistPin ?? undefined);
  },
}));
