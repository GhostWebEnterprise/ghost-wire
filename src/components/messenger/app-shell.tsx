import { useEffect, useState } from "react";
import { Toaster, toast } from "sonner";
import { StatusBar } from "@/components/messenger/android";
import { CallOverlay, InviteDialog, LockScreen, Onboarding, VaultPanel } from "@/components/messenger/overlays";
import { ChatPane } from "@/components/messenger/chat-pane";
import { ContactsPanel } from "@/components/messenger/contacts";
import { LiveBridge } from "@/components/messenger/live-bridge";
import { BottomNav, ConversationList } from "@/components/messenger/sidebar";
import { WireAuth } from "@/components/messenger/wire-auth";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useVault } from "@/lib/messenger/store";
import { toVaultConversation } from "@/lib/wire/bridge";
import { useWire } from "@/lib/wire/store";
import { cn } from "@/lib/utils";

function useMobile() {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const apply = () => setMobile(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return mobile;
}

export function AppShell() {
  const phase = useVault((s) => s.phase);
  const boot = useVault((s) => s.boot);
  const connectWire = useVault((s) => s.connectWire);
  const purgeExpired = useVault((s) => s.purgeExpired);
  const settings = useVault((s) => s.settings);
  const lock = useVault((s) => s.lock);
  const hasPin = useVault((s) => s.hasPin);
  const rail = useVault((s) => s.rail);
  const activeId = useVault((s) => s.activeId);
  const setActive = useVault((s) => s.setActive);
  const conversations = useVault((s) => s.conversations);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const mobile = useMobile();

  // ── Wire account lifecycle ────────────────────────────────────────────────
  const wireStatus = useWire((s) => s.status);
  const wireError = useWire((s) => s.error);
  const initWire = useWire((s) => s.init);
  const clearWireError = useWire((s) => s.clearError);

  useEffect(() => {
    void initWire();
  }, [initWire]);

  // Boot the local vault only once there is a signed-in Wire account.
  useEffect(() => {
    if (wireStatus !== "ready") return;
    boot();
    void connectWire();
  }, [wireStatus, boot, connectWire]);

  // MLS sync loop: install welcomes, refresh contacts/conversations, decrypt
  // new ciphertext and merge it into the messenger store.
  useEffect(() => {
    if (wireStatus !== "ready") return;
    let alive = true;
    const run = async () => {
      const wire = useWire.getState();
      const result = await wire.sync();
      if (!alive || !result) return;
      const vault = useVault.getState();
      const meId = wire.session?.user.id ?? "";
      for (const conversation of result.conversations) {
        vault.addWireConversation(
          toVaultConversation({
            conversation,
            identity: vault.identity,
            meId,
            connections: wire.connections,
          }),
        );
      }
      for (const incoming of result.messages) {
        vault.ingestRemote(incoming.conversationId, incoming.message);
      }
    };
    void run();
    const timer = window.setInterval(() => void run(), 3500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [wireStatus]);

  useEffect(() => {
    // While the sign-in screen owns the UI, its errors must stay on screen —
    // toasting + clearing here made every failed sign-in look like a dead
    // button (the Toaster only exists inside the signed-in shell).
    if (!wireError || wireStatus !== "ready") return;
    toast(wireError);
    clearWireError();
  }, [wireError, wireStatus, clearWireError]);

  useEffect(() => {
    const id = window.setInterval(purgeExpired, 5000);
    return () => window.clearInterval(id);
  }, [purgeExpired]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l" && hasPin) {
        e.preventDefault();
        void lock();
      }
      if (settings.screenshotShield && e.key === "PrintScreen") {
        e.preventDefault();
        toast("Capture blocked by vault policy");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasPin, lock, settings.screenshotShield]);

  useEffect(() => {
    if (!settings.screenshotShield) return;
    const onVis = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [settings.screenshotShield]);

  if (wireStatus === "checking") {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-bg text-sm text-muted">
        <span className="size-5 animate-spin rounded-full border-2 border-border border-t-ice" />
        Connecting to the Wire backend…
      </div>
    );
  }
  if (wireStatus === "signed-out") return <WireAuth />;

  if (phase === "boot") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg text-sm text-muted">
        Opening vault…
      </div>
    );
  }
  if (phase === "onboarding") return <Onboarding />;
  if (phase === "locked") return <LockScreen />;

  const live = conversations.filter((c) => c.kind === "live" && c.roomCode);
  const inChat = Boolean(activeId) && rail !== "vault";
  const showList = !mobile || !inChat;
  const showChat = (!mobile && rail !== "vault") || (mobile && inChat);
  const showVault = rail === "vault";
  const showNav = !mobile || !inChat;

  return (
    <TooltipProvider>
      <div
        className={cn(
          "flex h-dvh flex-col overflow-hidden bg-bg text-fg",
          settings.screenshotShield && "vault-shield",
          hidden && "vault-blur",
        )}
      >
        <StatusBar />
        <div className="flex min-h-0 flex-1">
          {showList && !showVault ? (
            rail === "people" ? (
              <div className="w-full min-w-0 md:w-[22rem] md:shrink-0 lg:w-[26rem]">
                <ContactsPanel />
              </div>
            ) : (
              <div className="w-full min-w-0 md:w-[22rem] md:shrink-0 lg:w-[26rem]">
                <ConversationList onInvite={() => setInviteOpen(true)} />
              </div>
            )
          ) : null}
          {showVault ? (
            <div className="min-w-0 flex-1 overflow-y-auto">
              <VaultPanel />
            </div>
          ) : null}
          {showChat ? (
            <div className="min-w-0 flex-1">
              <ChatPane onBack={mobile ? () => setActive(null) : undefined} />
            </div>
          ) : null}
        </div>
        {showNav ? <BottomNav /> : null}
        {live.map((c) => (
          <LiveBridge key={c.id} conversation={c} />
        ))}
        <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />
        <CallOverlay />
        <Toaster
          theme="dark"
          position="bottom-center"
          toastOptions={{
            className: "bg-panel text-fg border border-border",
          }}
        />
      </div>
    </TooltipProvider>
  );
}
