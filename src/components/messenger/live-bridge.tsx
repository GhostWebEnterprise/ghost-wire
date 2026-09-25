import { useEffect, useRef } from "react";
import { useP2PRoom } from "@/lib/multiplayer";
import { decryptText, deriveRoomKey, encryptText, roomIdFromCode } from "@/lib/messenger/crypto";
import { registerLivePipe, useVault } from "@/lib/messenger/store";
import type { Conversation, Message } from "@/lib/messenger/types";

export function LiveBridge({ conversation }: { conversation: Conversation }) {
  const identity = useVault((s) => s.identity);
  const ingestRemote = useVault((s) => s.ingestRemote);
  const setLivePeers = useVault((s) => s.setLivePeers);
  const room = roomIdFromCode(conversation.roomCode ?? conversation.id);
  const p2p = useP2PRoom({ room, name: identity?.callsign ?? "operator" });
  const keyRef = useRef<CryptoKey | null>(null);

  useEffect(() => {
    let cancelled = false;
    void deriveRoomKey(room).then((key) => {
      if (!cancelled) keyRef.current = key;
    });
    return () => {
      cancelled = true;
    };
  }, [room]);

  useEffect(() => {
    setLivePeers(conversation.id, p2p.peers.filter((p) => p.connectionState === "connected").length);
  }, [conversation.id, p2p.peers, setLivePeers]);

  useEffect(() => {
    return p2p.onMessage((from, data, channel) => {
      if (channel !== "reliable") return;
      const envelope = data as { type?: string; payload?: string; message?: Message };
      void (async () => {
        const key = keyRef.current;
        if (envelope.type === "msg" && envelope.payload && key) {
          try {
            const plain = await decryptText(key, envelope.payload);
            const parsed = JSON.parse(plain) as Message;
            ingestRemote(conversation.id, { ...parsed, fromId: from, mine: false });
          } catch {
            /* drop undecryptable */
          }
          return;
        }
        if (envelope.type === "msg" && envelope.message) {
          ingestRemote(conversation.id, { ...envelope.message, fromId: from, mine: false });
        }
      })();
    });
  }, [p2p, conversation.id, ingestRemote]);

  useEffect(() => {
    return registerLivePipe(conversation.id, (payload) => {
      const message = (payload as { message: Message }).message;
      void (async () => {
        const key = keyRef.current;
        if (key) {
          const sealed = await encryptText(key, JSON.stringify(message));
          p2p.send({ type: "msg", payload: sealed });
        } else {
          p2p.send({ type: "msg", message });
        }
      })();
    });
  }, [conversation.id, p2p]);

  return null;
}
