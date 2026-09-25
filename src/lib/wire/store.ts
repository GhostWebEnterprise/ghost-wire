/**
 * The Wire account store — sign-in/registration state, contacts, conversations
 * and MLS synchronisation for this device.
 *
 * Server state (connections, conversations, ciphertext) lives here and is
 * polled; decrypted messages are handed to the messenger store
 * (`@/lib/messenger/store`) by the app shell, which keeps the two stores free
 * of an import cycle.
 */
import { create } from "zustand";
import type { Message } from "@/lib/messenger/types";
import {
  buildWelcomes,
  clearWireCrypto,
  createKeyPackage,
  decryptMessage,
  deviceClass,
  encryptMessage,
  loadDeviceKeys,
  loadEpoch,
  loadOrCreateDeviceKeys,
  newEpochSecret,
  openWelcome,
  saveEpoch,
  verifyKeyPackage,
} from "./mls";
import {
  clearWireSession,
  ensureFreshSession,
  getWireSession,
  setWireSession,
} from "./session";
import type {
  WireConnection,
  WireConversation,
  WireSession,
  WireUser,
} from "./types";
import {
  wireActivate,
  wireClaimKeyPackages,
  wireCreateConnection,
  wireCreateConversation,
  wireGetConnections,
  wireGetConversations,
  wireGetMessages,
  wireGetWelcomes,
  wireKeyPackageCount,
  wireLogin,
  wireLogout,
  wirePostMessage,
  wirePostWelcomes,
  wireRecoverConfirm,
  wireRecoverRequest,
  wireRegister,
  wireRegisterDevice,
  wireRemoteLogin,
  wireSearchUsers,
  wireUpdateConnection,
} from "./api";
import type {
  WireRecoverConfirmResult,
  WireRecoverRequestResult,
  WireRegisterInput,
} from "./types";

export type WireStatus = "checking" | "signed-out" | "ready";

/** What a sync pass found — the app shell pipes this into the messenger store. */
export interface WireSyncResult {
  conversations: WireConversation[];
  messages: { conversationId: string; message: Message }[];
  /** True when a welcome installed a new epoch key this pass. */
  welcomed: boolean;
}

/** Everything pending for a registration awaiting its activation code. */
export interface WireActivation {
  email: string;
  delivery: "email" | "in-app";
  /** Present only when no mail provider is configured (in-app demo inbox). */
  code?: string;
}

interface WireState {
  status: WireStatus;
  session: WireSession | null;
  initialized: boolean;
  busy: boolean;
  error: string | null;
  activation: WireActivation | null;
  connections: WireConnection[];
  conversations: WireConversation[];
  clientId: string | null;
  packageCount: number;

  init: () => Promise<void>;
  register: (input: WireRegisterInput) => Promise<boolean>;
  activate: (email: string, code: string) => Promise<boolean>;
  /** `provider: "wire"` signs in against wire.com's production backend. */
  login: (email: string, password: string, provider?: "local" | "wire") => Promise<boolean>;
  recoverRequest: (email: string) => Promise<WireRecoverRequestResult>;
  recoverConfirm: (
    email: string,
    code: string,
    password: string,
  ) => Promise<WireRecoverConfirmResult>;
  logout: () => Promise<void>;
  clearError: () => void;
  dismissActivation: () => void;

  search: (query: string) => Promise<WireUser[]>;
  requestConnection: (userId: string, message?: string) => Promise<void>;
  respondConnection: (
    userId: string,
    action: "accept" | "ignore" | "block" | "cancel",
  ) => Promise<void>;
  refreshConnections: () => Promise<void>;

  ensureDevice: () => Promise<{ clientId: string; packageCount: number }>;
  openChat: (peerId: string) => Promise<WireConversation>;
  sendMlsMessage: (
    conversationId: string,
    body: string,
    type?: "text" | "knock",
  ) => Promise<{ id: string; at: number }>;
  sync: () => Promise<WireSyncResult | null>;
}

/** Newest ciphertext we've processed per conversation (inclusive cursor). */
const cursor = new Map<string, string>();

/**
 * One device-registration round trip at a time. Concurrent callers (sign-in,
 * the vault's Sync keys, opening a chat) used to race two upload batches at
 * the backend — the second one's inserts collided with the first's.
 */
let deviceFlight: Promise<{ clientId: string; packageCount: number }> | null = null;

function messageFromError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong talking to the Wire backend.";
}

function isUnauthorized(err: unknown): boolean {
  return err instanceof Error && err.message === "Unauthorized";
}

/** The peer of a 1:1 conversation, resolved against my connections. */
function peerOf(
  conversation: WireConversation,
  meId: string,
  connections: WireConnection[],
): { id: string; name: string } | null {
  const other = conversation.members.find((m) => m.userId !== meId);
  if (!other) return null;
  const connection = connections.find((c) => c.peer.id === other.userId);
  return { id: other.userId, name: connection?.peer.name ?? "Contact" };
}

export const useWire = create<WireState>((set, get) => ({
  status: "checking",
  session: null,
  initialized: false,
  busy: false,
  error: null,
  activation: null,
  connections: [],
  conversations: [],
  clientId: null,
  packageCount: 0,

  clearError: () => set({ error: null }),
  dismissActivation: () => set({ activation: null }),

  init: async () => {
    if (get().initialized) return;
    const session = getWireSession();
    if (!session) {
      set({ status: "signed-out", initialized: true });
      return;
    }
    const fresh = await ensureFreshSession();
    if (!fresh) {
      clearWireSession();
      set({ status: "signed-out", initialized: true, session: null });
      return;
    }
    set({ status: "ready", session: fresh, initialized: true });
    try {
      await get().ensureDevice();
      await get().refreshConnections();
    } catch (err) {
      if (isUnauthorized(err)) void get().logout();
      else set({ error: messageFromError(err) });
    }
  },

  register: async (input) => {
    set({ busy: true, error: null, activation: null });
    try {
      const result = await wireRegister({ data: input });
      if (!result.ok) {
        set({ busy: false, error: result.error });
        return false;
      }
      set({
        busy: false,
        activation: {
          email: input.email.trim().toLowerCase(),
          delivery: result.activation.delivery,
          code: result.activation.code,
        },
      });
      return true;
    } catch (err) {
      set({ busy: false, error: messageFromError(err) });
      return false;
    }
  },

  activate: async (email, code) => {
    set({ busy: true, error: null });
    try {
      const result = await wireActivate({ data: { email, code } });
      if (!result.ok) {
        set({ busy: false, error: result.error });
        return false;
      }
      set({ busy: false, activation: null });
      return true;
    } catch (err) {
      set({ busy: false, error: messageFromError(err) });
      return false;
    }
  },

  login: async (email, password, provider = "local") => {
    set({ busy: true, error: null });
    try {
      const device = await loadOrCreateDeviceKeys();
      const result =
        provider === "wire"
          ? await wireRemoteLogin({ data: { email, password, clientId: device.clientId } })
          : await wireLogin({ data: { email, password, clientId: device.clientId } });
      if (!result.ok) {
        set({ busy: false, error: result.error });
        return false;
      }
      setWireSession(result.session);
      set({ busy: false, session: result.session, status: "ready", activation: null });
      try {
        await get().ensureDevice();
        await get().refreshConnections();
      } catch (err) {
        // Sign-in itself succeeded — device setup is retryable (vault → Sync
        // keys), so it must not flip the result to a failed sign-in.
        set({ error: messageFromError(err) });
      }
      return true;
    } catch (err) {
      set({ busy: false, error: messageFromError(err) });
      return false;
    }
  },

  recoverRequest: async (email) => {
    set({ busy: true, error: null });
    try {
      const result = await wireRecoverRequest({ data: { email } });
      set({ busy: false, error: result.ok ? null : result.error });
      return result;
    } catch (err) {
      const message = messageFromError(err);
      set({ busy: false, error: message });
      return { ok: false, error: message };
    }
  },

  recoverConfirm: async (email, code, password) => {
    set({ busy: true, error: null });
    try {
      const result = await wireRecoverConfirm({ data: { email, code, password } });
      set({ busy: false, error: result.ok ? null : result.error });
      return result;
    } catch (err) {
      const message = messageFromError(err);
      set({ busy: false, error: message });
      return { ok: false, error: message };
    }
  },

  logout: async () => {
    try {
      await wireLogout();
    } catch {
      /* token may already be dead server-side — local sign-out still holds */
    }
    clearWireSession();
    clearWireCrypto();
    cursor.clear();
    set({
      status: "signed-out",
      session: null,
      connections: [],
      conversations: [],
      clientId: null,
      packageCount: 0,
      error: null,
      activation: null,
    });
  },

  search: async (query) => {
    try {
      return await wireSearchUsers({ data: { query } });
    } catch (err) {
      if (isUnauthorized(err)) void get().logout();
      else set({ error: messageFromError(err) });
      return [];
    }
  },

  requestConnection: async (userId, message) => {
    set({ busy: true, error: null });
    try {
      const connections = await wireCreateConnection({ data: { userId, message } });
      set({ connections, busy: false });
    } catch (err) {
      set({ busy: false, error: messageFromError(err) });
    }
  },

  respondConnection: async (userId, action) => {
    try {
      const connections = await wireUpdateConnection({ data: { userId, action } });
      set({ connections });
    } catch (err) {
      set({ error: messageFromError(err) });
    }
  },

  refreshConnections: async () => {
    try {
      const connections = await wireGetConnections();
      set({ connections });
    } catch (err) {
      if (isUnauthorized(err)) void get().logout();
      else set({ error: messageFromError(err) });
    }
  },

  /**
   * Register this browser's MLS client and keep its key package pool full —
   * peers claim one whenever they start a conversation with us.
   */
  ensureDevice: async () => {
    if (deviceFlight) return deviceFlight;
    const flight = (async () => {
      const device = await loadOrCreateDeviceKeys();
      // Trust the SERVER's pool count, not the last known client state: peers
      // claim packages when they start conversations with us, so the local
      // number goes stale the moment someone does.
      const remote = await wireKeyPackageCount();
      if (get().clientId === device.clientId && remote.count >= 2) {
        set({ clientId: device.clientId, packageCount: remote.count });
        return { clientId: device.clientId, packageCount: remote.count };
      }
      const packages = await Promise.all([
        createKeyPackage(device),
        createKeyPackage(device),
        createKeyPackage(device),
        createKeyPackage(device),
        createKeyPackage(device),
      ]);
      const registered = await wireRegisterDevice({
        data: {
          clientId: device.clientId,
          ...deviceClass(),
          fingerprint: device.fingerprint,
          packages,
        },
      });
      set({ clientId: registered.client.id, packageCount: registered.packageCount });
      return { clientId: registered.client.id, packageCount: registered.packageCount };
    })();
    deviceFlight = flight.finally(() => {
      deviceFlight = null;
    });
    return deviceFlight;
  },

  /**
   * Start (or resume) a 1:1 conversation with an accepted contact and mint
   * the MLS epoch: claim the peer's key package, seal the epoch secret to it
   * and store the secret for this device.
   */
  openChat: async (peerId) => {
    const session = get().session;
    if (!session) throw new Error("Sign in first.");
    set({ busy: true, error: null });
    try {
      await get().ensureDevice();
      const conversation = await wireCreateConversation({
        data: { otherUserIds: [peerId] },
      });

      if (!loadEpoch(conversation.id)) {
        if (conversation.creator === session.user.id) {
          const packages = await wireClaimKeyPackages({ data: { userIds: [peerId] } });
          const usable = [];
          for (const pkg of packages) {
            if (await verifyKeyPackage(pkg.data)) usable.push(pkg);
          }
          if (usable.length === 0) {
            throw new Error(
              "That contact has no key package yet — ask them to open GhostWire once.",
            );
          }
          const secret = newEpochSecret();
          const envelopes = await buildWelcomes({
            conversationId: conversation.id,
            epoch: conversation.epoch,
            secret,
            members: usable.map((p) => ({
              clientId: p.clientId,
              initKey: p.data.initKey,
            })),
          });
          await wirePostWelcomes({
            data: {
              conversationId: conversation.id,
              epoch: conversation.epoch,
              recipients: usable.map((p, i) => ({
                userId: p.userId,
                clientId: p.clientId,
                payload: JSON.stringify(envelopes[i]),
              })),
            },
          });
          saveEpoch(conversation.id, {
            epoch: conversation.epoch,
            secret,
            updatedAt: Date.now(),
          });
        }
        // Otherwise the peer created it: their welcome arrives on the next
        // sync pass and installs the epoch secret for this device.
      }

      set((state) => ({
        busy: false,
        conversations: state.conversations.some((c) => c.id === conversation.id)
          ? state.conversations
          : [...state.conversations, conversation],
      }));
      return conversation;
    } catch (err) {
      set({ busy: false, error: messageFromError(err) });
      throw err;
    }
  },

  /** Encrypt + post one application message; returns its server id and time. */
  sendMlsMessage: async (conversationId, body, type = "text") => {
    const session = get().session;
    if (!session) throw new Error("Sign in first.");
    const device = loadDeviceKeys() ?? (await loadOrCreateDeviceKeys());
    const epoch = loadEpoch(conversationId);
    if (!epoch) {
      throw new Error("This conversation has no epoch key on this device yet.");
    }
    const payload = await encryptMessage({
      secret: epoch.secret,
      conversationId,
      epoch: epoch.epoch,
      sender: { user: session.user.id, client: device.clientId },
      type,
      body,
    });
    const row = await wirePostMessage({
      data: {
        id: crypto.randomUUID(),
        conversationId,
        senderClient: device.clientId,
        epoch: epoch.epoch,
        contentType: type,
        payload,
      },
    });
    return { id: row.id, at: Date.parse(row.createdAt) };
  },

  /**
   * One poll pass: install pending welcomes, refresh contacts + conversations,
   * then decrypt any new ciphertext for conversations this device holds a key
   * for. Returns what the app shell should merge into the messenger store.
   */
  sync: async () => {
    const session = get().session;
    if (!session || get().status !== "ready") return null;
    try {
      const device = loadDeviceKeys();
      let welcomed = false;

      if (device) {
        const welcomes = await wireGetWelcomes();
        for (const welcome of welcomes) {
          const current = loadEpoch(welcome.conversationId);
          if (current && current.welcomeId === welcome.id) continue;
          const envelope = JSON.parse(welcome.payload) as Parameters<
            typeof openWelcome
          >[0]["envelope"];
          const secret = await openWelcome({
            envelope,
            keys: device,
            conversationId: welcome.conversationId,
            epoch: welcome.epoch,
          });
          if (!secret) continue;
          saveEpoch(welcome.conversationId, {
            epoch: welcome.epoch,
            secret,
            welcomeId: welcome.id,
            updatedAt: Date.now(),
          });
          welcomed = true;
        }
      }

      const [connections, conversations] = await Promise.all([
        wireGetConnections(),
        wireGetConversations(),
      ]);
      set({ connections, conversations });

      const messages: { conversationId: string; message: Message }[] = [];
      const meId = session.user.id;

      for (const conversation of conversations) {
        const epoch = loadEpoch(conversation.id);
        if (!epoch || !device) continue;
        const rows = await wireGetMessages({
          data: {
            conversationId: conversation.id,
            since: cursor.get(conversation.id) ?? null,
          },
        });
        const peer = peerOf(conversation, meId, connections);
        for (const row of rows) {
          const plain = await decryptMessage({
            secret: epoch.secret,
            payload: row.payload,
            conversationId: row.conversationId,
            epoch: row.epoch,
            sender: { user: row.sender, client: row.senderClient },
            contentType: row.contentType,
          });
          if (!plain) continue; // wrong epoch / not for us — retry next pass
          cursor.set(conversation.id, row.createdAt);
          const mine = row.sender === meId;
          messages.push({
            conversationId: conversation.id,
            message: {
              id: row.id,
              conversationId: conversation.id,
              kind: plain.type === "knock" ? "knock" : "text",
              fromId: row.sender,
              fromName: mine ? session.user.name : (peer?.name ?? "Contact"),
              body: plain.body,
              at: plain.at || Date.parse(row.createdAt),
              ttlHours: 0,
              delivered: true,
              mine,
            },
          });
        }
      }

      return { conversations, messages, welcomed };
    } catch (err) {
      if (isUnauthorized(err)) void get().logout();
      else set({ error: messageFromError(err) });
      return null;
    }
  },
}));
