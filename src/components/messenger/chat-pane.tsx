import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import {
  ArrowLeft,
  Check,
  Clock,
  Flag,
  Info,
  Paperclip,
  Phone,
  Radio,
  Send,
  Shield,
  ShieldAlert,
  ShieldQuestion,
  Timer,
  Video,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { PersonMark } from "@/components/messenger/mark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { demoDevices } from "@/lib/messenger/seed";
import { formatTime, ttlLabel } from "@/lib/messenger/format";
import { WIRE_CIPHER_SUITE } from "@/lib/wire/mls";
import { useVault } from "@/lib/messenger/store";
import type { Conversation, Message, TtlHours } from "@/lib/messenger/types";
import { cn } from "@/lib/utils";

export function ChatPane({ onBack }: { onBack?: () => void }) {
  const conversations = useVault((s) => s.conversations);
  const messages = useVault((s) => s.messages);
  const activeId = useVault((s) => s.activeId);
  const infoOpen = useVault((s) => s.infoOpen);
  const setInfoOpen = useVault((s) => s.setInfoOpen);
  const conv = conversations.find((c) => c.id === activeId) ?? null;
  const list = conv ? (messages[conv.id] ?? []) : [];

  if (!conv) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-bg px-6 text-center">
        <Shield className="size-8 text-subtle" />
        <p className="mt-4 text-lg font-medium">Select a conversation</p>
        <p className="mt-1 max-w-sm text-sm text-muted">
          Independent Android client. Inbox is local. Open a sealed channel to pair another GhostWire
          device — delivery links through wire.com, keys stay on device.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0">
      <section className="flex min-w-0 flex-1 flex-col bg-bg">
        <ChatHeader conversation={conv} onBack={onBack} onInfo={() => setInfoOpen(!infoOpen)} />
        <MessageList conversation={conv} messages={list} />
        <Composer conversation={conv} />
      </section>
      {infoOpen ? <InfoPanel conversation={conv} onClose={() => setInfoOpen(false)} /> : null}
    </div>
  );
}

function ChatHeader({
  conversation,
  onBack,
  onInfo,
}: {
  conversation: Conversation;
  onBack?: () => void;
  onInfo: () => void;
}) {
  const startCall = useVault((s) => s.startCall);
  const knock = useVault((s) => s.knock);

  return (
    <header className="flex items-center gap-2 border-b border-border bg-surface px-2 py-2 sm:px-4">
      {onBack ? (
        <button
          className="flex size-10 items-center justify-center rounded-md text-muted hover:bg-elevated hover:text-fg md:hidden"
          onClick={onBack}
          aria-label="Back"
        >
          <ArrowLeft className="size-4" />
        </button>
      ) : null}
      <PersonMark name={conversation.title} hue={conversation.hue} verified={conversation.verified} />
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-1.5 truncate text-sm font-medium">
          <span className="truncate">{conversation.title}</span>
          {conversation.wire ? (
            <Badge tone="ice" className="shrink-0">
              MLS
            </Badge>
          ) : null}
        </p>
        <p className="truncate text-[11px] text-muted">
          {conversation.kind === "live"
            ? `${conversation.livePeers ?? 0} peer · ${conversation.roomCode}`
            : conversation.wire
              ? `${conversation.subtitle}${conversation.verified ? " · verified" : " · unverified"}`
              : conversation.verified
                ? "PQ · MLS · sealed"
                : "Unverified fingerprint"}
        </p>
      </div>
      <div className="flex items-center">
        <IconBtn label="Voice" onClick={() => startCall(conversation.id, "audio")}>
          <Phone className="size-4" />
        </IconBtn>
        <IconBtn label="Video" onClick={() => startCall(conversation.id, "video")}>
          <Video className="size-4" />
        </IconBtn>
        <IconBtn label="Knock" onClick={() => knock(conversation.id)}>
          <Zap className="size-4" />
        </IconBtn>
        <IconBtn label="Details" onClick={onInfo}>
          <Info className="size-4" />
        </IconBtn>
      </div>
    </header>
  );
}

function IconBtn({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      aria-label={label}
      onClick={onClick}
      className="flex size-10 items-center justify-center rounded-md text-muted hover:bg-elevated hover:text-fg"
    >
      {children}
    </button>
  );
}

function MessageList({ conversation, messages }: { conversation: Conversation; messages: Message[] }) {
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages.length, conversation.id]);

  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6">
      <div className="mx-auto flex max-w-2xl flex-col gap-3">
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} conversation={conversation} />
        ))}
      </div>
    </div>
  );
}

function MessageBubble({ message, conversation }: { message: Message; conversation: Conversation }) {
  const react = useVault((s) => s.react);
  const openDeadDrop = useVault((s) => s.openDeadDrop);
  const hue = conversation.members.find((m) => m.id === message.fromId)?.hue ?? conversation.hue;

  if (message.kind === "system") {
    return (
      <p className="py-1 text-center font-mono text-[11px] tracking-wide text-subtle">{message.body}</p>
    );
  }

  if (message.kind === "knock") {
    return (
      <p className="py-1 text-center text-xs text-ice">{message.fromName} knocked on this channel</p>
    );
  }

  const sealedDrop = message.kind === "dead-drop" && message.sealed && !message.mine;
  const emptyDrop = message.kind === "dead-drop" && (message.mine || message.consumed) && !message.body;

  return (
    <article className={cn("flex gap-2", message.mine ? "flex-row-reverse" : "flex-row")}>
      {!message.mine ? <PersonMark name={message.fromName} hue={hue} size="sm" /> : null}
      <div className={cn("max-w-[min(100%,28rem)]", message.mine && "items-end")}>
        {!message.mine && conversation.kind === "group" ? (
          <p className="mb-1 px-1 text-[11px] text-muted">{message.fromName}</p>
        ) : null}
        <div
          className={cn(
            "rounded-lg px-3 py-2 text-sm leading-relaxed",
            message.mine ? "bg-self text-fg" : "bg-elevated text-fg",
            message.kind === "dead-drop" && "border border-dashed border-ice/40",
          )}
        >
          {message.replyTo ? (
            <p className="mb-1.5 border-l-2 border-ice/50 pl-2 text-xs text-muted">
              {message.replyTo.fromName}: {message.replyTo.body}
            </p>
          ) : null}
          {sealedDrop ? (
            <button
              className="flex items-center gap-2 text-ice"
              onClick={() => openDeadDrop(conversation.id, message.id)}
            >
              <ShieldAlert className="size-4" />
              Break seal — one-shot
            </button>
          ) : emptyDrop ? (
            <span className="text-muted">
              Dead drop {message.mine ? "sent" : "consumed"} · no copy retained
            </span>
          ) : (
            <p className="whitespace-pre-wrap">{message.body}</p>
          )}
          {message.fileName ? <p className="mt-1 text-xs text-ice">{message.fileName}</p> : null}
        </div>
        <div className={cn("mt-1 flex items-center gap-2 px-1", message.mine && "justify-end")}>
          <span className="font-mono text-[10px] tabular-nums text-subtle">{formatTime(message.at)}</span>
          {message.ttlHours ? (
            <span className="flex items-center gap-0.5 text-[10px] text-subtle">
              <Timer className="size-2.5" />
              {ttlLabel(message.ttlHours)}
            </span>
          ) : null}
          <button
            className={cn("text-subtle hover:text-fg", message.reaction === "ack" && "text-verified")}
            aria-label="Acknowledge"
            onClick={() => react(conversation.id, message.id, "ack")}
          >
            <Check className="size-3" />
          </button>
          <button
            className={cn("text-subtle hover:text-fg", message.reaction === "flag" && "text-warn")}
            aria-label="Flag"
            onClick={() => react(conversation.id, message.id, "flag")}
          >
            <Flag className="size-3" />
          </button>
          <button
            className={cn("text-subtle hover:text-fg", message.reaction === "hold" && "text-ice")}
            aria-label="Hold"
            onClick={() => react(conversation.id, message.id, "hold")}
          >
            <Clock className="size-3" />
          </button>
        </div>
      </div>
    </article>
  );
}

function Composer({ conversation }: { conversation: Conversation }) {
  const sendMessage = useVault((s) => s.sendMessage);
  const setTtl = useVault((s) => s.setTtl);
  const [text, setText] = useState("");
  const [drop, setDrop] = useState(conversation.kind === "dead-drop");
  const [fileName, setFileName] = useState<string | undefined>();
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setDrop(conversation.kind === "dead-drop");
    setText("");
    setFileName(undefined);
  }, [conversation.id, conversation.kind]);

  function submit() {
    const body = text.trim();
    if (!body && !fileName) return;
    void sendMessage(conversation.id, {
      body,
      kind: drop ? "dead-drop" : fileName ? "file" : "text",
      ttlHours: conversation.ttlHours,
      fileName,
    });
    setText("");
    setFileName(undefined);
    if (area.current) area.current.style.height = "auto";
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function onInput(e: FormEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  const ttlOptions: TtlHours[] = [0, 1, 24, 72];

  return (
    <footer className="border-t border-border bg-surface px-3 py-3 sm:px-4">
      <div className="mx-auto flex max-w-2xl items-end gap-2">
        <label className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-elevated hover:text-fg">
          <Paperclip className="size-4" />
          <input
            type="file"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                if (file.size > 25 * 1024 * 1024) {
                  toast("Max 25 MiB");
                  return;
                }
                setFileName(file.name);
              }
            }}
          />
        </label>
        <div className="min-w-0 flex-1 rounded-lg bg-elevated px-3 py-1.5">
          {fileName ? (
            <p className="mb-1 flex items-center justify-between text-xs text-ice">
              {fileName}
              <button type="button" className="text-muted" onClick={() => setFileName(undefined)}>
                Remove
              </button>
            </p>
          ) : null}
          <textarea
            ref={area}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            onInput={onInput}
            placeholder={drop ? "Sealed one-shot…" : "Message"}
            className="max-h-40 w-full resize-none bg-transparent text-sm text-fg placeholder:text-subtle focus-visible:outline-none"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              aria-label="Timer"
              className="flex size-10 shrink-0 items-center justify-center rounded-md text-muted hover:bg-elevated hover:text-fg"
            >
              <Timer className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {ttlOptions.map((h) => (
              <DropdownMenuItem key={h} onSelect={() => setTtl(conversation.id, h)}>
                {ttlLabel(h)} {conversation.ttlHours === h ? "· current" : ""}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          aria-label="Dead drop"
          onClick={() => setDrop((v) => !v)}
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-md",
            drop ? "bg-ice/15 text-ice" : "text-muted hover:bg-elevated hover:text-fg",
          )}
        >
          <ShieldAlert className="size-4" />
        </button>
        <Button size="icon" aria-label="Send" disabled={!text.trim() && !fileName} onClick={submit}>
          <Send className="size-4" />
        </Button>
      </div>
    </footer>
  );
}

function InfoPanel({ conversation, onClose }: { conversation: Conversation; onClose: () => void }) {
  const verifyContact = useVault((s) => s.verifyContact);
  const toggleMute = useVault((s) => s.toggleMute);
  const archive = useVault((s) => s.archive);
  const selfId = useVault((s) => s.identity?.id);
  const other = conversation.members.find((m) => m.id !== selfId) ?? conversation.members[0];

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col overflow-y-auto border-l border-border bg-surface max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-40 max-lg:w-[min(100%,22rem)] max-lg:shadow-[var(--shadow-border)]">
      <header className="flex items-center justify-between px-4 py-3">
        <h2 className="text-sm font-medium">Details</h2>
        <button onClick={onClose} className="text-sm text-muted hover:text-fg">
          Close
        </button>
      </header>
      <div className="flex flex-col items-center px-4 pb-4">
        <PersonMark name={conversation.title} hue={conversation.hue} size="lg" verified={conversation.verified} />
        <p className="mt-3 font-medium">{conversation.title}</p>
        <p className="mt-1 text-xs text-muted">{conversation.subtitle}</p>
        <div className="mt-3 flex flex-wrap justify-center gap-1.5">
          <Badge tone={conversation.verified ? "verified" : "warn"}>
            {conversation.verified ? "Verified" : "Unverified"}
          </Badge>
          <Badge tone="ice">PQ ratchet</Badge>
          {conversation.wire ? (
            <Badge tone="ice">MLS · wire.com</Badge>
          ) : conversation.kind === "group" ? (
            <Badge>MLS</Badge>
          ) : (
            <Badge>1:1</Badge>
          )}
          {conversation.kind === "live" ? (
            <Badge tone="ice">
              <Radio className="size-3" />
              Live
            </Badge>
          ) : null}
        </div>
      </div>
      <div className="space-y-4 px-4 pb-6">
        <section>
          <p className="text-[11px] tracking-wide text-subtle uppercase">Fingerprint</p>
          <p className="mt-1 font-mono text-xs leading-relaxed text-fg">{other?.fingerprint}</p>
          {!conversation.verified ? (
            <Button variant="ice" size="sm" className="mt-2" onClick={() => verifyContact(conversation.id)}>
              <ShieldQuestion className="size-3.5" />
              Mark verified
            </Button>
          ) : null}
        </section>
        {conversation.roomCode ? (
          <section>
            <p className="text-[11px] tracking-wide text-subtle uppercase">Invite</p>
            <button
              className="mt-1 font-mono text-sm text-ice"
              onClick={() => {
                void navigator.clipboard.writeText(conversation.roomCode ?? "");
                toast("Invite copied");
              }}
            >
              {conversation.roomCode}
            </button>
          </section>
        ) : null}
        <section>
          <p className="text-[11px] tracking-wide text-subtle uppercase">Members</p>
          <ul className="mt-2 space-y-2">
            {conversation.members.map((m) => (
              <li key={m.id} className="flex items-center gap-2">
                <PersonMark name={m.name} hue={m.hue} size="sm" verified={m.verified} />
                <span className="min-w-0">
                  <span className="block truncate text-sm">{m.name}</span>
                  <span className="block font-mono text-[10px] text-subtle">{m.fingerprint}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <p className="text-[11px] tracking-wide text-subtle uppercase">
            {conversation.wire ? "MLS session" : "Devices"}
          </p>
          {conversation.wire ? (
            <div className="mt-1 space-y-1">
              <p className="text-sm">End-to-end encrypted · ciphertext at rest</p>
              <p className="font-mono text-[10px] break-all text-subtle">
                {WIRE_CIPHER_SUITE}
              </p>
              <p className="text-xs text-muted">
                The backend stores sealed payloads only — keys live on your devices.
              </p>
            </div>
          ) : (
            <ul className="mt-2 space-y-2">
              {demoDevices.map((d) => (
                <li key={d.id} className="flex items-center justify-between text-sm">
                  <span>
                    {d.label}
                    <span className="ml-2 text-xs text-subtle">{d.platform}</span>
                  </span>
                  <span className="text-xs text-muted">{d.lastSeenAgo}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => toggleMute(conversation.id)}>
            {conversation.muted ? "Unmute" : "Mute"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => archive(conversation.id, !conversation.archived)}>
            {conversation.archived ? "Unarchive" : "Archive"}
          </Button>
        </div>
      </div>
    </aside>
  );
}
