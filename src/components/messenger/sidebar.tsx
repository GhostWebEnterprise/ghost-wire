import { Archive, Inbox, Plus, Radio, Search, Settings, ShieldAlert, Users } from "lucide-react";
import { PersonMark } from "@/components/messenger/mark";
import { formatListTime } from "@/lib/messenger/format";
import { useVault } from "@/lib/messenger/store";
import type { Conversation, RailView } from "@/lib/messenger/types";
import { useWire } from "@/lib/wire/store";
import { cn } from "@/lib/utils";

const rails: { id: RailView; label: string; icon: typeof Inbox }[] = [
  { id: "inbox", label: "Chats", icon: Inbox },
  { id: "people", label: "Contacts", icon: Users },
  { id: "live", label: "Channels", icon: Radio },
  { id: "drops", label: "Drops", icon: ShieldAlert },
  { id: "archive", label: "Archive", icon: Archive },
  { id: "vault", label: "Vault", icon: Settings },
];

export function BottomNav() {
  const rail = useVault((s) => s.rail);
  const setRail = useVault((s) => s.setRail);
  const setActive = useVault((s) => s.setActive);
  // Chats: total unread across live conversations. Contacts: contact requests
  // waiting for an answer (the sync loop refreshes connections every pass).
  const unread = useVault((s) =>
    s.conversations.reduce((n, c) => n + (c.archived ? 0 : c.unread), 0),
  );
  const requests = useWire(
    (s) =>
      s.connections.filter((c) => c.status === "pending" && c.direction === "incoming")
        .length,
  );
  const badgeFor = (id: RailView) =>
    id === "inbox" ? unread : id === "people" ? requests : 0;

  return (
    <nav className="flex h-16 shrink-0 items-stretch border-t border-border bg-surface pb-[env(safe-area-inset-bottom)]">
      {rails.map((item) => {
        const Icon = item.icon;
        const active = rail === item.id;
        const badge = badgeFor(item.id);
        return (
          <button
            key={item.id}
            aria-label={item.label}
            onClick={() => {
              setRail(item.id);
              if (item.id === "vault") setActive(null);
            }}
            className={cn(
              "flex flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium",
              active ? "text-fg" : "text-subtle",
            )}
          >
            <span className="relative">
              <Icon className={cn("size-5", active && "text-ice")} />
              {badge > 0 ? (
                <span className="absolute -right-2.5 -top-1.5 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] font-semibold leading-4 text-accent-fg">
                  {badge > 9 ? "9+" : badge}
                </span>
              ) : null}
            </span>
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}

const chips: { id: RailView; label: string }[] = [
  { id: "inbox", label: "All" },
  { id: "live", label: "Channels" },
  { id: "drops", label: "Drops" },
  { id: "archive", label: "Archive" },
];

export function ConversationList({ onInvite }: { onInvite: () => void }) {
  const conversations = useVault((s) => s.conversations);
  const activeId = useVault((s) => s.activeId);
  const setActive = useVault((s) => s.setActive);
  const rail = useVault((s) => s.rail);
  const setRail = useVault((s) => s.setRail);
  const query = useVault((s) => s.query);
  const setQuery = useVault((s) => s.setQuery);

  const filtered = conversations
    .filter((c) => {
      if (rail === "archive") return c.archived;
      if (c.archived) return false;
      if (rail === "live") return c.kind === "live";
      if (rail === "drops") return c.kind === "dead-drop";
      return true;
    })
    .filter((c) => {
      if (!query.trim()) return true;
      const q = query.toLowerCase();
      return c.title.toLowerCase().includes(q) || c.lastPreview.toLowerCase().includes(q);
    })
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastAt - a.lastAt);

  const title =
    rail === "live"
      ? "Sealed channels"
      : rail === "drops"
        ? "Dead drops"
        : rail === "archive"
          ? "Archive"
          : "Conversations";

  return (
    <aside className="relative flex h-full min-w-0 flex-col bg-surface md:border-r md:border-border">
      <header className="px-4 pb-2 pt-3">
        <p className="text-[11px] font-medium tracking-[0.16em] text-ice uppercase">GhostWire for Android</p>
        <h1 className="text-2xl font-medium tracking-tight">{title}</h1>
      </header>
      <div className="flex gap-1 overflow-x-auto px-3 pb-2">
        {chips.map((chip) => (
          <button
            key={chip.id}
            onClick={() => setRail(chip.id)}
            className={cn(
              "h-8 shrink-0 rounded-full px-3 text-xs font-medium",
              rail === chip.id ? "bg-accent text-accent-fg" : "bg-elevated text-muted",
            )}
          >
            {chip.label}
          </button>
        ))}
      </div>
      <div className="px-3 pb-2">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations"
            className="h-11 w-full rounded-full bg-elevated pl-10 pr-4 text-sm text-fg placeholder:text-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ice/50"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-20">
        {filtered.length === 0 ? (
          <div className="px-4 py-8 text-sm text-muted">
            <p>
              {rail === "live"
                ? "No sealed channels yet. Tap + to invite a peer — pairing stays local, delivery via wire.com."
                : rail === "drops"
                  ? "No dead drops waiting."
                  : rail === "archive"
                    ? "Nothing archived."
                    : "No conversations yet."}
            </p>
            {rail === "inbox" ? (
              <button
                onClick={() => setRail("people")}
                className="mt-3 rounded-full bg-accent px-4 py-2 text-xs font-medium text-accent-fg"
              >
                Find contacts
              </button>
            ) : null}
          </div>
        ) : (
          filtered.map((c) => (
            <ConversationRow
              key={c.id}
              conversation={c}
              active={c.id === activeId}
              onSelect={() => setActive(c.id)}
            />
          ))
        )}
      </div>
      <button
        onClick={onInvite}
        aria-label="New sealed channel"
        className="absolute bottom-5 right-4 flex size-14 items-center justify-center rounded-full bg-accent text-accent-fg shadow-[var(--shadow-border)] transition-transform duration-150 active:scale-[0.96]"
      >
        <Plus className="size-6" />
      </button>
    </aside>
  );
}

function ConversationRow({
  conversation,
  active,
  onSelect,
}: {
  conversation: Conversation;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={cn(
        "flex min-h-16 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-150",
        active ? "bg-elevated" : "hover:bg-elevated/60",
        conversation.knocked && "knock-flash",
      )}
    >
      <PersonMark
        name={conversation.title}
        hue={conversation.hue}
        verified={conversation.verified}
        size="md"
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-[15px] font-medium">{conversation.title}</span>
          <span className="ml-auto shrink-0 text-[11px] tabular-nums text-subtle">
            {formatListTime(conversation.lastAt)}
          </span>
        </span>
        <span className="mt-0.5 flex items-center gap-2">
          <span className="truncate text-[13px] text-muted">{conversation.lastPreview}</span>
          {conversation.unread > 0 ? (
            <span className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-accent px-1.5 text-[11px] font-medium text-accent-fg">
              {conversation.unread}
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );
}
