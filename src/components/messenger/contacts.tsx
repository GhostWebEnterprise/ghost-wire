import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  Check,
  LogOut,
  MessageSquare,
  Search,
  Shield,
  ShieldCheck,
  UserPlus,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { PersonMark } from "@/components/messenger/mark";
import { useVault } from "@/lib/messenger/store";
import { toVaultConversation, hueFor } from "@/lib/wire/bridge";
import { useWire } from "@/lib/wire/store";
import type { WireConnection, WireUser } from "@/lib/wire/types";
import { isPeerVerified, setPeerVerified } from "@/lib/wire/verified";

/**
 * The contacts rail: Wire's social graph, end to end.
 *
 * Search the directory (`/users`), send a connection request
 * (`POST /connections`), accept what comes in (`PUT /connections/{id}`), then
 * start an MLS conversation (`POST /conversations` + welcome + key packages).
 */
export function ContactsPanel() {
  const session = useWire((s) => s.session);
  const connections = useWire((s) => s.connections);
  const busy = useWire((s) => s.busy);
  const search = useWire((s) => s.search);
  const requestConnection = useWire((s) => s.requestConnection);
  const respondConnection = useWire((s) => s.respondConnection);
  const openChat = useWire((s) => s.openChat);
  const logout = useWire((s) => s.logout);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WireUser[]>([]);
  const [searching, setSearching] = useState(false);
  // Bumped after a local trust-list change so the rows re-render.
  const [, setVerifyTick] = useState(0);

  // Debounced directory lookup — Wire searches once you have a real term.
  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setResults([]);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(async () => {
      setSearching(true);
      const found = await search(term);
      if (!alive) return;
      setResults(found);
      setSearching(false);
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [query, search]);

  const incoming = connections.filter(
    (c) => c.status === "pending" && c.direction === "incoming",
  );
  const outgoing = connections.filter(
    (c) => c.status === "pending" && c.direction === "outgoing",
  );
  const accepted = dedupeByPeer(
    connections.filter((c) => c.status === "accepted"),
  );

  function connectionFor(userId: string): WireConnection | undefined {
    return connections.find((c) => c.peer.id === userId);
  }

  async function startChat(peer: WireUser) {
    const vault = useVault.getState();
    const meId = session?.user.id;
    if (!meId) return;
    try {
      const conversation = await openChat(peer.id);
      vault.addWireConversation(
        toVaultConversation({
          conversation,
          identity: vault.identity,
          meId,
          peer,
        }),
      );
      vault.setRail("inbox");
      vault.setActive(conversation.id);
    } catch {
      /* the store surfaces the error as a toast */
    }
  }

  function toggleVerified(peerId: string) {
    const next = !isPeerVerified(peerId);
    setPeerVerified(peerId, next);
    if (next) {
      const vault = useVault.getState();
      const conversation = vault.conversations.find((c) => c.peerId === peerId);
      if (conversation) vault.verifyContact(conversation.id);
    }
    setVerifyTick((t) => t + 1);
  }

  return (
    <aside className="flex h-full min-w-0 flex-col bg-surface md:border-r md:border-border">
      <header className="flex items-start justify-between gap-3 px-4 pb-3 pt-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium tracking-[0.16em] text-ice uppercase">
            Wire connections
          </p>
          <h1 className="text-2xl font-medium tracking-tight">Contacts</h1>
          {session ? (
            <p className="mt-1 flex items-center gap-1 truncate text-xs text-muted">
              {session.user.name} ·{" "}
              <button
                type="button"
                title="Copy your handle so people can find you"
                onClick={() => {
                  void navigator.clipboard.writeText(`@${session.user.handle}`);
                  toast("Handle copied — share it so people can find you");
                }}
                className="truncate font-mono decoration-dotted underline-offset-2 hover:text-fg hover:underline"
              >
                @{session.user.handle}
              </button>
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => void logout()}
          title="Sign out of this Wire account"
          className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted hover:bg-elevated hover:text-fg"
        >
          <LogOut className="size-4" />
        </button>
      </header>

      <div className="px-3 pb-2">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search @handle, name or email"
            className="h-11 w-full rounded-full bg-elevated pl-10 pr-4 text-sm text-fg placeholder:text-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ice/50"
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-24">
        {query.trim().length >= 2 ? (
          <section className="px-3 pb-3">
            <SectionLabel>
              {searching ? "Searching directory…" : "Directory"}
            </SectionLabel>
            {results.length === 0 && !searching ? (
              <p className="px-1 py-2 text-sm text-muted">No accounts match “{query.trim()}”.</p>
            ) : null}
            {results.map((user) => (
              <PersonRow
                key={user.id}
                user={user}
                connection={connectionFor(user.id)}
                busy={busy}
                onConnect={() => void requestConnection(user.id)}
                onAccept={() => void respondConnection(user.id, "accept")}
                onIgnore={() => void respondConnection(user.id, "ignore")}
                onMessage={() => void startChat(user)}
                onToggleVerified={() => toggleVerified(user.id)}
              />
            ))}
          </section>
        ) : null}

        <section className="px-3 pb-3">
          <SectionLabel>Requests</SectionLabel>
          {incoming.length === 0 && outgoing.length === 0 ? (
            <p className="px-1 py-2 text-sm text-muted">
              No pending requests. Search for someone above to connect.
            </p>
          ) : null}
          {incoming.map((connection) => (
            <PersonRow
              key={`in-${connection.peer.id}`}
              user={connection.peer}
              connection={connection}
              busy={busy}
              onAccept={() => void respondConnection(connection.peer.id, "accept")}
              onIgnore={() => void respondConnection(connection.peer.id, "ignore")}
              onMessage={() => void startChat(connection.peer)}
              onToggleVerified={() => toggleVerified(connection.peer.id)}
            />
          ))}
          {outgoing.map((connection) => (
            <PersonRow
              key={`out-${connection.peer.id}`}
              user={connection.peer}
              connection={connection}
              busy={busy}
              onCancel={() => void respondConnection(connection.peer.id, "cancel")}
              onToggleVerified={() => toggleVerified(connection.peer.id)}
            />
          ))}
        </section>

        <section className="px-3 pb-3">
          <SectionLabel>Connections</SectionLabel>
          {accepted.length === 0 ? (
            <p className="px-1 py-2 text-sm text-muted">
              Accepted connections show up here with their MLS fingerprint.
            </p>
          ) : null}
          {accepted.map((connection) => (
            <PersonRow
              key={`acc-${connection.peer.id}`}
              user={connection.peer}
              connection={connection}
              busy={busy}
              onMessage={() => void startChat(connection.peer)}
              onToggleVerified={() => toggleVerified(connection.peer.id)}
            />
          ))}
        </section>
      </div>
    </aside>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-1 pb-1 pt-2 text-[11px] font-medium tracking-[0.14em] text-subtle uppercase">
      {children}
    </p>
  );
}

function dedupeByPeer(connections: WireConnection[]): WireConnection[] {
  const seen = new Set<string>();
  const out: WireConnection[] = [];
  for (const connection of connections) {
    if (seen.has(connection.peer.id)) continue;
    seen.add(connection.peer.id);
    out.push(connection);
  }
  return out;
}

function PersonRow({
  user,
  connection,
  busy,
  onConnect,
  onAccept,
  onIgnore,
  onCancel,
  onMessage,
  onToggleVerified,
}: {
  user: WireUser;
  connection?: WireConnection;
  busy: boolean;
  onConnect?: () => void;
  onAccept?: () => void;
  onIgnore?: () => void;
  onCancel?: () => void;
  onMessage?: () => void;
  onToggleVerified?: () => void;
}) {
  const verified = isPeerVerified(user.id);
  const status = connection?.status ?? user.connectionStatus ?? "none";

  return (
    <div className="flex items-center gap-3 rounded-lg px-1 py-2 hover:bg-elevated/50">
      <PersonMark name={user.name} hue={hueFor(user.handle)} verified={verified} size="md" />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 truncate text-[15px] font-medium">
          <span className="truncate">{user.name}</span>
          {user.self ? <Badge tone="ice">you</Badge> : null}
          {status === "accepted" ? <Badge tone="verified">connected</Badge> : null}
          {status === "pending" ? <Badge tone="warn">pending</Badge> : null}
          {status === "blocked" ? <Badge tone="danger">blocked</Badge> : null}
        </p>
        <p className="truncate text-[13px] text-muted">
          <span className="font-mono">@{user.handle}</span>
          {user.fingerprint ? (
            <span className="ml-2 font-mono text-[11px] text-subtle">
              {user.fingerprint.slice(0, 9)}…
            </span>
          ) : null}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {user.fingerprint && onToggleVerified ? (
          <button
            type="button"
            title={verified ? "Fingerprint verified on this device" : "Mark fingerprint verified"}
            onClick={onToggleVerified}
            className={`flex size-8 items-center justify-center rounded-md hover:bg-elevated ${
              verified ? "text-verified" : "text-subtle"
            }`}
          >
            {verified ? <ShieldCheck className="size-4" /> : <Shield className="size-4" />}
          </button>
        ) : null}

        {user.self ? null : status === "accepted" && onMessage ? (
          <button
            type="button"
            disabled={busy}
            onClick={onMessage}
            className="flex h-8 items-center gap-1 rounded-full bg-accent px-3 text-xs font-medium text-accent-fg disabled:opacity-60"
          >
            <MessageSquare className="size-3.5" /> Message
          </button>
        ) : status === "pending" && connection?.direction === "incoming" && onAccept ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={onAccept}
              aria-label="Accept contact request"
              className="flex size-8 items-center justify-center rounded-full bg-accent text-accent-fg disabled:opacity-60"
            >
              <Check className="size-4" />
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onIgnore}
              aria-label="Ignore contact request"
              className="flex size-8 items-center justify-center rounded-full bg-elevated text-muted hover:text-fg disabled:opacity-60"
            >
              <X className="size-4" />
            </button>
          </>
        ) : status === "pending" && connection?.direction === "outgoing" ? (
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="h-8 rounded-full bg-elevated px-3 text-xs font-medium text-muted hover:text-fg disabled:opacity-60"
          >
            Requested
          </button>
        ) : onConnect ? (
          <button
            type="button"
            disabled={busy}
            onClick={onConnect}
            className="flex h-8 items-center gap-1 rounded-full border border-border bg-elevated px-3 text-xs font-medium text-fg hover:bg-accent hover:text-accent-fg disabled:opacity-60"
          >
            <UserPlus className="size-3.5" /> Connect
          </button>
        ) : null}
      </div>
    </div>
  );
}
