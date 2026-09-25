import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  Archive,
  Check,
  Copy,
  Fingerprint,
  KeyRound,
  Lock,
  LogOut,
  Mic,
  MicOff,
  PhoneOff,
  Shield,
  Video,
  VideoOff,
  Wifi,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { GhostMark, PersonMark } from "@/components/messenger/mark";
import {
  createVaultBackup,
  downloadBackup,
  readBackupFile,
  restoreVaultBackup,
  type BackupFile,
} from "@/lib/messenger/backup";
import { formatDuration, ttlLabel } from "@/lib/messenger/format";
import { useVault } from "@/lib/messenger/store";
import type { TtlHours } from "@/lib/messenger/types";
import { WIRE_BACKEND_HOST } from "@/lib/messenger/types";
import { getWireSession } from "@/lib/wire/session";
import { useWire } from "@/lib/wire/store";

export function Onboarding() {
  const completeOnboarding = useVault((s) => s.completeOnboarding);
  const busy = useVault((s) => s.busy);
  const error = useVault((s) => s.error);
  const wire = useVault((s) => s.wire);
  const connectWire = useVault((s) => s.connectWire);
  // Prefill the local callsign from the signed-in Wire account so the device
  // vault starts out named like the account it belongs to.
  const [callsign, setCallsign] = useState(() => getWireSession()?.user.name ?? "Operator");
  const account = getWireSession();
  const [pin, setPin] = useState("");
  const [duress, setDuress] = useState("");

  return (
    <main className="relative flex min-h-dvh items-center justify-center px-5 py-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(158,179,199,0.08),transparent_55%)]" />
      <section className="stagger-in relative w-full max-w-md rounded-xl border border-border bg-surface p-6 sm:p-8">
        <GhostMark className="size-10" />
        <p className="mt-5 font-mono text-[11px] tracking-[0.22em] text-ice uppercase">
          GhostWire for Android
        </p>
        <h1 className="mt-2 text-3xl font-medium tracking-tight text-fg">
          Independent messenger. Connects to wire.com.
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          A standalone Android client in the Wire protocol lineage — not affiliated with Wire Swiss
          GmbH. Links to the wire.com backend for delivery, keeps keys in a local vault. Zero
          identity, invite pairing, hybrid post-quantum ratchet. Package{" "}
          <span className="font-mono text-fg">app.ghostwire</span>.
        </p>
        <button
          type="button"
          className="mt-4 flex w-full items-center justify-between rounded-lg border border-border bg-elevated px-3 py-2 text-left"
          onClick={() => void connectWire()}
        >
          <span className="flex items-center gap-2">
            <span
              className={`size-1.5 rounded-full ${
                wire.phase === "online"
                  ? "bg-verified"
                  : wire.phase === "connecting"
                    ? "bg-warn"
                    : "bg-danger"
              }`}
            />
            <span className="text-xs text-muted">
              {wire.phase === "online"
                ? `wire.com linked · ${wire.probe?.domain ?? "wire.com"} · ${wire.probe?.latencyMs ?? "—"}ms`
                : wire.phase === "connecting"
                  ? "Linking to wire.com…"
                  : `wire.com unreachable${wire.probe?.error ? ` · ${wire.probe.error}` : ""}`}
            </span>
          </span>
          <span className="font-mono text-[10px] tracking-wide text-subtle uppercase">Retry</span>
        </button>
        {account ? (
          <p className="mt-3 text-xs text-subtle">
            Signed in as{" "}
            <span className="font-mono text-muted">@{account.user.handle}</span> · {account.user.email}
          </p>
        ) : null}
        <label className="mt-6 block text-xs font-medium text-muted">Callsign</label>
        <Input
          className="mt-1.5"
          value={callsign}
          onChange={(e) => setCallsign(e.target.value)}
          maxLength={24}
          autoComplete="off"
        />
        <label className="mt-4 block text-xs font-medium text-muted">Vault PIN — optional</label>
        <Input
          className="mt-1.5"
          type="password"
          inputMode="numeric"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          placeholder="Locks the vault on this device"
          autoComplete="new-password"
        />
        <label className="mt-4 block text-xs font-medium text-muted">Duress PIN — optional</label>
        <Input
          className="mt-1.5"
          type="password"
          inputMode="numeric"
          value={duress}
          onChange={(e) => setDuress(e.target.value)}
          placeholder="Wipes keys and messages"
          autoComplete="new-password"
        />
        {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
        <Button
          className="mt-6 w-full"
          disabled={busy || callsign.trim().length < 2}
          onClick={() => void completeOnboarding(callsign, pin || undefined, duress || undefined)}
        >
          Create local vault
        </Button>
        <p className="mt-4 text-xs leading-relaxed text-subtle">
          Connects to wire.com. Built for GrapheneOS &amp; custom ROMs, and Android devices with or
          without Google Play Services.
        </p>
      </section>
    </main>
  );
}

export function LockScreen() {
  const unlock = useVault((s) => s.unlock);
  const [pin, setPin] = useState("");
  const [status, setStatus] = useState<"idle" | "bad" | "duress">("idle");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    const result = await unlock(pin);
    setBusy(false);
    if (result === "ok") return;
    if (result === "duress") {
      setStatus("duress");
      toast("Vault destroyed");
      return;
    }
    setStatus("bad");
    setPin("");
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-5">
      <section className="w-full max-w-sm rounded-xl border border-border bg-surface p-7 text-center">
        <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-elevated">
          <Lock className="size-5 text-ice" />
        </span>
        <h1 className="mt-4 text-xl font-medium tracking-tight">Vault locked</h1>
        <p className="mt-2 text-sm text-muted">Enter the vault PIN. The duress PIN wipes this device.</p>
        <Input
          className="mt-5 text-center tracking-[0.4em]"
          type="password"
          inputMode="numeric"
          value={pin}
          autoFocus
          onChange={(e) => setPin(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
        />
        {status === "bad" ? <p className="mt-2 text-sm text-danger">PIN rejected</p> : null}
        <Button className="mt-5 w-full" disabled={busy || pin.length < 4} onClick={() => void submit()}>
          Unlock
        </Button>
      </section>
    </main>
  );
}

export function CallOverlay() {
  const call = useVault((s) => s.call);
  const conversations = useVault((s) => s.conversations);
  const endCall = useVault((s) => s.endCall);
  const [muted, setMuted] = useState(false);
  const [camOff, setCamOff] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!call) return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [call]);

  if (!call) return null;
  const conv = conversations.find((c) => c.id === call.conversationId);

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-bg/95 px-6">
      <PersonMark name={conv?.title ?? "Channel"} hue={conv?.hue ?? 0} size="lg" />
      <p className="mt-5 text-lg font-medium">{conv?.title ?? "Channel"}</p>
      <p className="mt-1 font-mono text-sm tabular-nums text-muted">
        {call.status === "ringing" ? "Sealing session…" : formatDuration(now - call.startedAt)}
      </p>
      <p className="mt-2 text-xs text-subtle">
        {call.mode === "video" ? "Video" : "Voice"} · ML-KEM frame keys · DTLS-SRTP
      </p>
      <div className="mt-10 flex items-center gap-3">
        <Button
          variant="outline"
          size="icon"
          aria-label={muted ? "Unmute" : "Mute"}
          onClick={() => setMuted((v) => !v)}
        >
          {muted ? <MicOff /> : <Mic />}
        </Button>
        {call.mode === "video" ? (
          <Button
            variant="outline"
            size="icon"
            aria-label={camOff ? "Camera on" : "Camera off"}
            onClick={() => setCamOff((v) => !v)}
          >
            {camOff ? <VideoOff /> : <Video />}
          </Button>
        ) : null}
        <Button variant="danger" size="lg" onClick={endCall}>
          <PhoneOff className="size-4" />
          End
        </Button>
      </div>
    </div>
  );
}

export function InviteDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createLive = useVault((s) => s.createLive);
  const joinLive = useVault((s) => s.joinLive);
  const [mode, setMode] = useState<"create" | "join">("create");
  const [code, setCode] = useState("");
  const [created, setCreated] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setCreated(null);
      setCode("");
      setMode("create");
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Sealed channel">
        <div className="mb-4 flex rounded-md bg-elevated p-1">
          {(["create", "join"] as const).map((id) => (
            <button
              key={id}
              className={`h-8 flex-1 rounded-sm text-sm capitalize ${mode === id ? "bg-surface text-fg" : "text-muted"}`}
              onClick={() => setMode(id)}
            >
              {id}
            </button>
          ))}
        </div>
        {mode === "create" ? (
          <div>
            <p className="text-sm text-muted">
              Pair another GhostWire Android client. The invite is the secret — content stays
              end-to-end sealed; wire.com only relays ciphertext.
            </p>
            {created ? (
              <div className="mt-4 rounded-lg bg-elevated p-4">
                <p className="font-mono text-lg tracking-[0.18em] text-fg">{created}</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => {
                    void navigator.clipboard.writeText(created);
                    toast("Invite copied");
                  }}
                >
                  <Copy className="size-3.5" />
                  Copy invite
                </Button>
              </div>
            ) : (
              <Button
                className="mt-5 w-full"
                onClick={() => {
                  const conv = createLive();
                  setCreated(conv.roomCode ?? "");
                }}
              >
                Generate invite
              </Button>
            )}
          </div>
        ) : (
          <div>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="GW-XXXX-XXXX"
              className="font-mono tracking-wide"
            />
            <Button
              className="mt-4 w-full"
              disabled={code.replace(/[^a-zA-Z0-9]/g, "").length < 6}
              onClick={() => {
                const conv = joinLive(code);
                if (!conv) {
                  toast("Invite rejected");
                  return;
                }
                onOpenChange(false);
              }}
            >
              Join channel
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

const forkRows = [
  ["Identity", "Email / phone account", "Zero identity, local vault"],
  ["Backend", "Wire Swiss cloud", "Links to wire.com + local vault"],
  ["Ratchet", "Proteus / MLS", "MLS + hybrid ML-KEM-768"],
  ["Ephemeral", "Timer messages", "Dead drops, no sender copy"],
  ["Lock", "App lock PIN", "Vault PIN + duress wipe"],
  ["Screenshots", "Optional FLAG_SECURE", "Shield on by default"],
  ["Presence", "Last seen", "Stealth, no last-seen"],
  ["Push", "FCM / HMS", "FCM optional — works without Play Services"],
];

export function VaultPanel() {
  const identity = useVault((s) => s.identity);
  const settings = useVault((s) => s.settings);
  const updateSettings = useVault((s) => s.updateSettings);
  const wire = useVault((s) => s.wire);
  const connectWire = useVault((s) => s.connectWire);
  const setPin = useVault((s) => s.setPin);
  const wipe = useVault((s) => s.wipe);
  const rename = useVault((s) => s.rename);
  const lock = useVault((s) => s.lock);
  const hasPin = useVault((s) => s.hasPin);
  const [callsign, setCallsign] = useState(identity?.callsign ?? "");
  const [pin, setPinValue] = useState("");
  const [duress, setDuress] = useState("");

  // Signed-in Wire account + this device's MLS registration (server truth:
  // the store refreshes the package count from the backend on every sync).
  const wireSession = useWire((s) => s.session);
  const clientId = useWire((s) => s.clientId);
  const packageCount = useWire((s) => s.packageCount);
  const ensureDevice = useWire((s) => s.ensureDevice);
  const wireLogout = useWire((s) => s.logout);
  const [keysBusy, setKeysBusy] = useState(false);

  // ── Backup & restore (säkerhetskopiering med återställningsnyckel) ───────
  const conversations = useVault((s) => s.conversations);
  const messages = useVault((s) => s.messages);
  const restoreVault = useVault((s) => s.restoreBackup);
  const [backupBusy, setBackupBusy] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [restoreFile, setRestoreFile] = useState<BackupFile | null>(null);
  const [restoreName, setRestoreName] = useState("");
  const [restoreKey, setRestoreKey] = useState("");
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreDone, setRestoreDone] = useState<string | null>(null);
  const restoreInputRef = useRef<HTMLInputElement>(null);
  const keyCopy = useCopied();

  const makeBackup = async () => {
    setBackupBusy(true);
    setRestoreError(null);
    setRestoreDone(null);
    try {
      const { file, recoveryKey: key } = await createVaultBackup({
        identity,
        conversations,
        messages,
      });
      downloadBackup(file);
      setRecoveryKey(key);
      toast(
        `Backup saved · ${file.stats.conversations} conversations · ${file.stats.messages} messages`,
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not create the backup");
    } finally {
      setBackupBusy(false);
    }
  };

  const onRestoreFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0];
    event.target.value = ""; // the same file must be pickable again
    setRestoreError(null);
    setRestoreDone(null);
    if (!picked) return;
    try {
      setRestoreFile(await readBackupFile(await picked.text()));
      setRestoreName(picked.name);
      setRestoreKey("");
    } catch (err) {
      setRestoreFile(null);
      setRestoreName("");
      setRestoreError(err instanceof Error ? err.message : "Could not read that file.");
    }
  };

  const doRestore = async () => {
    if (!restoreFile) return;
    setRestoreBusy(true);
    setRestoreError(null);
    setRestoreDone(null);
    try {
      const stats = restoreFile.stats;
      const payload = await restoreVaultBackup(restoreFile, restoreKey);
      const counts = await restoreVault(payload);
      const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
      setRestoreDone(
        counts.conversations || counts.messages || counts.epochs
          ? `Restored ${plural(counts.conversations, "conversation")} · ${plural(counts.messages, "message")} · ${plural(counts.epochs, "session key")}`
          : `Backup verified — all ${stats.conversations} conversations are already in this vault`,
      );
      setRestoreFile(null);
      setRestoreName("");
      setRestoreKey("");
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : "Could not restore that backup.");
    } finally {
      setRestoreBusy(false);
    }
  };

  const syncKeys = async () => {
    setKeysBusy(true);
    try {
      const result = await ensureDevice();
      toast(`Device registered · ${result.packageCount} key packages ready`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not sync device keys");
    } finally {
      setKeysBusy(false);
    }
  };

  useEffect(() => setCallsign(identity?.callsign ?? ""), [identity?.callsign]);

  const ttlOptions: TtlHours[] = [0, 1, 24, 72];

  return (
    <div className="mx-auto w-full max-w-lg space-y-6 px-5 py-6 pb-10">
      <header>
        <p className="font-mono text-[11px] tracking-[0.2em] text-ice uppercase">app.ghostwire</p>
        <h1 className="mt-1 text-2xl font-medium tracking-tight">Android vault</h1>
      </header>

      <section className="rounded-lg border border-border bg-surface p-4">
        <div className="flex items-center gap-3">
          <PersonMark name={identity?.callsign ?? "GW"} hue={0} verified />
          <div className="min-w-0">
            <p className="truncate font-medium">{identity?.callsign}</p>
            <p className="font-mono text-[11px] text-muted">{identity?.fingerprint}</p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label="Copy fingerprint"
            onClick={() => {
              if (identity?.fingerprint) {
                void navigator.clipboard.writeText(identity.fingerprint);
                toast("Fingerprint copied");
              }
            }}
          >
            <Copy className="size-4" />
          </Button>
        </div>
        <label className="mt-4 block text-xs text-muted">Callsign</label>
        <div className="mt-1.5 flex gap-2">
          <Input value={callsign} onChange={(e) => setCallsign(e.target.value)} maxLength={24} />
          <Button variant="outline" onClick={() => rename(callsign)}>
            Save
          </Button>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface p-4 space-y-3">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <KeyRound className="size-4 text-ice" />
          Wire account
        </h2>
        {wireSession ? (
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm">
                <span className="font-medium">{wireSession.user.name}</span>
                <span className="ml-2 font-mono text-xs text-muted">
                  @{wireSession.user.handle}
                </span>
              </p>
              <p className="mt-1 truncate font-mono text-[11px] text-subtle">
                {wireSession.user.email}
              </p>
              <p className="mt-1 truncate font-mono text-[11px] text-subtle">
                {clientId ? `device ${clientId.slice(0, 12)}…` : "device not registered"}
                {" · "}
                {packageCount} key package{packageCount === 1 ? "" : "s"}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                disabled={keysBusy}
                onClick={() => void syncKeys()}
              >
                {keysBusy ? "Syncing…" : "Sync keys"}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Sign out of this Wire account"
                onClick={() => void wireLogout()}
              >
                <LogOut className="size-4" />
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted">No Wire account signed in on this device.</p>
        )}
      </section>

      <section className="rounded-lg border border-border bg-surface p-4 space-y-3">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Wifi className="size-4 text-ice" />
          wire.com link
        </h2>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm">
              <span
                className={`size-1.5 rounded-full ${
                  wire.phase === "online"
                    ? "bg-verified"
                    : wire.phase === "connecting"
                      ? "bg-warn"
                      : "bg-danger"
                }`}
              />
              {wire.phase === "online"
                ? `Connected · ${wire.probe?.host ?? WIRE_BACKEND_HOST}`
                : wire.phase === "connecting"
                  ? "Connecting to wire.com…"
                  : "Not connected"}
            </p>
            <p className="mt-1 font-mono text-[11px] text-subtle">
              {wire.probe
                ? [
                    wire.probe.domain ? `domain ${wire.probe.domain}` : null,
                    wire.probe.federation ? "federation on" : null,
                    wire.probe.supported?.length ? `api v${Math.max(...wire.probe.supported)}` : null,
                    wire.probe.latencyMs != null ? `${wire.probe.latencyMs}ms` : null,
                    wire.probe.error ?? null,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : "no probe yet"}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={wire.phase === "connecting"}
            onClick={() => void connectWire()}
          >
            {wire.phase === "connecting" ? "Linking…" : wire.phase === "online" ? "Re-check" : "Connect"}
          </Button>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface p-4 space-y-3">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Archive className="size-4 text-ice" />
          Backup &amp; restore
        </h2>
        <p className="text-xs leading-relaxed text-muted">
          Säkerhetskopiering: seal every conversation, message and MLS session key into a{" "}
          <span className="font-mono text-fg">.gwbak</span> file guarded by a one-time recovery
          key. Keep file and key apart — one is useless without the other. After a restore, wire.com
          conversations refill automatically and decrypt with the restored session keys.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            disabled={backupBusy}
            onClick={() => void makeBackup()}
          >
            {backupBusy ? "Encrypting…" : "Create backup"}
          </Button>
          {recoveryKey ? (
            <Button variant="ghost" onClick={() => void keyCopy.copy(recoveryKey)}>
              <keyCopy.Icon className="size-4" />
              {keyCopy.ok ? "Copied" : "Copy recovery key"}
            </Button>
          ) : null}
        </div>

        {recoveryKey ? (
          <div className="rounded-md border border-dashed border-border bg-elevated px-3 py-2">
            <p className="text-[11px] text-subtle">
              Recovery key (återställningsnyckel) — shown once, write it down
            </p>
            <code className="mt-1 block break-all font-mono text-sm text-ice">{recoveryKey}</code>
          </div>
        ) : null}

        <div className="space-y-2 border-t border-border pt-3">
          <p className="text-sm">Återställ — restore from a backup file</p>
          <input
            ref={restoreInputRef}
            type="file"
            accept=".gwbak,.json,application/json"
            className="hidden"
            onChange={(e) => void onRestoreFile(e)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => restoreInputRef.current?.click()}>
              Choose backup file
            </Button>
            {restoreFile && restoreName ? (
              <span className="font-mono text-xs text-muted">
                {restoreName} · {restoreFile.stats.conversations} conversations ·{" "}
                {restoreFile.stats.messages} messages
              </span>
            ) : null}
          </div>
          {restoreFile ? (
            <div className="space-y-2">
              <Input
                placeholder="Recovery key (GW1-…-…)"
                value={restoreKey}
                onChange={(e) => setRestoreKey(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <Button
                disabled={restoreBusy || restoreKey.trim().length < 8}
                onClick={() => void doRestore()}
              >
                {restoreBusy ? "Restoring…" : "Restore"}
              </Button>
            </div>
          ) : null}
          {restoreError ? <p className="text-sm text-danger">{restoreError}</p> : null}
          {restoreDone ? <p className="text-sm text-ice">{restoreDone}</p> : null}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface p-4 space-y-4">
        <h2 className="text-sm font-medium">Hardening</h2>
        <Row
          label="Screenshot shield"
          hint="FLAG_SECURE analogue — blocks capture"
          checked={settings.screenshotShield}
          onChange={(v) => updateSettings({ screenshotShield: v })}
        />
        <Row
          label="Stealth"
          hint="Hide last-seen and typing"
          checked={settings.stealth}
          onChange={(v) => updateSettings({ stealth: v })}
        />
        <Row
          label="Cover traffic"
          hint="Pad live channels with dummy frames"
          checked={settings.coverTraffic}
          onChange={(v) => updateSettings({ coverTraffic: v })}
        />
        <Row
          label="Read receipts"
          hint="Off by default"
          checked={settings.readReceipts}
          onChange={(v) => updateSettings({ readReceipts: v })}
        />
        <div>
          <p className="text-sm">Default timer</p>
          <div className="mt-2 flex gap-1">
            {ttlOptions.map((h) => (
              <button
                key={h}
                onClick={() => updateSettings({ defaultTtl: h })}
                className={`h-8 rounded-full px-3 text-xs ${settings.defaultTtl === h ? "bg-accent text-accent-fg" : "bg-elevated text-muted"}`}
              >
                {ttlLabel(h)}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface p-4 space-y-3">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Fingerprint className="size-4 text-ice" />
          PIN
        </h2>
        <Input
          type="password"
          inputMode="numeric"
          placeholder={hasPin ? "Replace vault PIN" : "Set vault PIN"}
          value={pin}
          onChange={(e) => setPinValue(e.target.value)}
        />
        <Input
          type="password"
          inputMode="numeric"
          placeholder="Duress PIN (wipe)"
          value={duress}
          onChange={(e) => setDuress(e.target.value)}
        />
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={pin.length < 4}
            onClick={() => {
              void setPin(pin, duress || undefined);
              setPinValue("");
              setDuress("");
              toast("Vault PIN stored locally");
            }}
          >
            Save PINs
          </Button>
          {hasPin ? (
            <Button variant="ghost" onClick={() => void lock()}>
              <Lock className="size-4" />
              Lock now
            </Button>
          ) : null}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Shield className="size-4 text-ice" />
          Independent fork
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          GhostWire is an independent Android client inspired by the open-source Wire protocol
          (Proteus / MLS / AVS). It is not a product of Wire Swiss GmbH and does not use Wire
          trademarks. Delivery links to the public wire.com backend; keys and messages stay in the
          local vault.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-subtle">
              <tr>
                <th className="pb-2 font-medium"> </th>
                <th className="pb-2 font-medium">Wire Android</th>
                <th className="pb-2 font-medium">GhostWire</th>
              </tr>
            </thead>
            <tbody className="text-fg">
              {forkRows.map((row) => (
                <tr key={row[0]} className="border-t border-border">
                  <td className="py-2 pr-2 text-muted">{row[0]}</td>
                  <td className="py-2 pr-2">{row[1]}</td>
                  <td className="py-2 text-ice">{row[2]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 font-mono text-[11px] text-subtle">
          v2.0.0 · app.ghostwire · GrapheneOS &amp; custom ROMs · with or without Play Services
        </p>
        <Button
          variant="danger"
          className="mt-4"
          onClick={() => {
            if (window.confirm("Destroy this vault? Keys and messages cannot be recovered.")) wipe();
          }}
        >
          Destroy vault
        </Button>
      </section>
    </div>
  );
}

function Row({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-4">
      <span>
        <span className="block text-sm">{label}</span>
        <span className="block text-xs text-subtle">{hint}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

export function useCopied() {
  const [ok, setOk] = useState(false);
  return {
    ok,
    copy: async (text: string) => {
      await navigator.clipboard.writeText(text);
      setOk(true);
      window.setTimeout(() => setOk(false), 1200);
    },
    Icon: ok ? Check : Copy,
  };
}
