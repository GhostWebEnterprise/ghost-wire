import { useEffect, useState, type FormEvent } from "react";
import { KeyRound, MailCheck, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { GhostMark } from "@/components/messenger/mark";
import { useVault } from "@/lib/messenger/store";
import { useWire } from "@/lib/wire/store";
import { cn } from "@/lib/utils";

type Mode = "signin" | "register" | "activate" | "recover";
type Provider = "local" | "wire";

/**
 * Wire's account front door: sign in (to this backend **or** to an existing
 * wire.com account), register (email + password + handle), the email
 * activation step Wire uses, and password recovery — restyled in GhostWire's
 * theme.
 *
 * Rendered by the app shell whenever there is no Wire session, so the app can
 * never run against an anonymous identity.
 */
export function WireAuth() {
  const status = useWire((s) => s.status);
  const busy = useWire((s) => s.busy);
  const error = useWire((s) => s.error);
  const activation = useWire((s) => s.activation);
  const clearError = useWire((s) => s.clearError);
  const dismissActivation = useWire((s) => s.dismissActivation);
  const login = useWire((s) => s.login);
  const register = useWire((s) => s.register);
  const activate = useWire((s) => s.activate);
  const recoverRequest = useWire((s) => s.recoverRequest);
  const recoverConfirm = useWire((s) => s.recoverConfirm);

  const wire = useVault((s) => s.wire);
  const connectWire = useVault((s) => s.connectWire);

  // Probe wire.com while the front door is on screen — the badge must reflect
  // the real link, not the idle default (which used to read "offline").
  useEffect(() => {
    void connectWire();
  }, [connectWire]);

  const [mode, setMode] = useState<Mode>("signin");
  const [provider, setProvider] = useState<Provider>("local");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [code, setCode] = useState(activation?.code ?? "");
  // Recovery: step 1 requested a code, step 2 sets the new password.
  const [recoverSent, setRecoverSent] = useState(false);
  const [recoverDelivery, setRecoverDelivery] = useState<
    "email" | "in-app" | "wire" | null
  >(null);

  const currentMode: Mode = activation ? "activate" : mode;

  function switchMode(next: Mode) {
    setMode(next);
    clearError();
    dismissActivation();
    if (next !== "recover") {
      setRecoverSent(false);
      setRecoverDelivery(null);
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (currentMode === "signin") {
      await login(email, password, provider);
      return;
    }
    if (currentMode === "register") {
      const ok = await register({
        name,
        email,
        password,
        handle: handle.trim() || undefined,
      });
      if (ok) {
        // Read the fresh activation (the store set it during `register`).
        const pending = useWire.getState().activation;
        if (pending?.code) setCode(pending.code);
        setMode("activate");
      }
      return;
    }
    if (currentMode === "recover") {
      if (!recoverSent) {
        const result = await recoverRequest(email);
        if (result.ok) {
          setRecoverDelivery(result.delivery);
          setRecoverSent(true);
          if (result.code) setCode(result.code);
        }
        return;
      }
      const result = await recoverConfirm(email, code.trim(), password);
      if (result.ok) {
        toast("Password updated — sign in with your new details");
        setProvider(recoverDelivery === "wire" ? "wire" : "local");
        setMode("signin");
        setRecoverSent(false);
        setRecoverDelivery(null);
        setCode("");
        setPassword("");
        clearError();
      }
      return;
    }
    const ok = await activate(email, code.trim());
    if (ok) await login(email, password);
  }

  const title =
    currentMode === "register"
      ? "Create your Wire account"
      : currentMode === "activate"
        ? "Confirm your email"
        : currentMode === "recover"
          ? recoverSent
            ? "Choose a new password"
            : "Reset your sign-in"
          : provider === "wire"
            ? "Sign in to wire.com"
            : "Sign in to Wire";

  const submitLabel =
    currentMode === "register"
      ? "Create account"
      : currentMode === "activate"
        ? "Activate & continue"
        : currentMode === "recover"
          ? recoverSent
            ? "Set new password"
            : "Send reset code"
          : "Sign in";

  const canSubmit =
    currentMode === "register"
      ? name.trim().length >= 1 && email.includes("@") && password.length >= 8 && !busy
      : currentMode === "activate"
        ? code.trim().length >= 4 && !busy
        : currentMode === "recover"
          ? recoverSent
            ? code.trim().length >= 4 && password.length >= 8 && !busy
            : email.includes("@") && !busy
          : email.includes("@") && password.length >= 1 && !busy;

  return (
    <main className="relative flex min-h-dvh items-center justify-center px-5 py-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(158,179,199,0.08),transparent_55%)]" />
      <section className="stagger-in relative w-full max-w-md rounded-xl border border-border bg-surface p-6 sm:p-8">
        <div className="flex items-start justify-between">
          <GhostMark className="size-10" />
          <span className="flex items-center gap-2 rounded-full border border-border bg-elevated px-2.5 py-1 text-[11px] text-muted">
            <span
              className={`size-1.5 rounded-full ${
                wire.phase === "online"
                  ? "bg-verified"
                  : wire.phase === "offline"
                    ? "bg-danger"
                    : "bg-warn"
              }`}
            />
            {wire.phase === "online"
              ? `wire.com linked · ${wire.probe?.latencyMs ?? "—"}ms`
              : wire.phase === "offline"
                ? "wire.com offline"
                : "Linking…"}
          </span>
        </div>

        <p className="mt-5 font-mono text-[11px] tracking-[0.22em] text-ice uppercase">
          GhostWire for Android
        </p>
        <h1 className="mt-2 text-3xl font-medium tracking-tight text-fg">{title}</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          {currentMode === "register"
            ? "Wire's registration flow: an email, a password and a handle. We send an activation code before the account goes live."
            : currentMode === "activate"
              ? `Enter the code we sent to ${activation?.email ?? email}.`
              : currentMode === "recover"
                ? recoverSent
                  ? `Enter the code for ${email} and pick a new password.`
                  : "We'll send a code to your sign-in email so you can choose a new password."
                : provider === "wire"
                  ? "Sign in with the wire.com account you already have — credentials go straight to Wire's backend and are never stored here."
                  : "Accounts, contacts and MLS sessions are served by the Wire-compatible backend this client speaks to."}
        </p>

        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          {currentMode === "register" ? (
            <label className="block">
              <span className="text-xs font-medium text-muted">Name</span>
              <Input
                className="mt-1.5"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ada Voss"
                autoComplete="name"
                maxLength={64}
              />
            </label>
          ) : null}

          {currentMode === "register" ? (
            <label className="block">
              <span className="text-xs font-medium text-muted">Handle (optional)</span>
              <Input
                className="mt-1.5"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                placeholder="ada_v"
                autoComplete="off"
                maxLength={21}
              />
            </label>
          ) : null}

          {currentMode === "activate" ? (
            <label className="block">
              <span className="text-xs font-medium text-muted">Activation code</span>
              <Input
                className="mt-1.5 text-center font-mono text-lg tracking-[0.5em]"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                autoFocus
              />
              {activation?.delivery === "in-app" && activation.code ? (
                <span className="mt-2 block rounded-md border border-dashed border-border bg-elevated px-3 py-2 text-xs text-muted">
                  In-app inbox · code{" "}
                  <button
                    type="button"
                    className="font-mono text-ice"
                    onClick={() => setCode(activation.code ?? "")}
                  >
                    {activation.code}
                  </button>{" "}
                  (no mail provider configured)
                </span>
              ) : null}
            </label>
          ) : currentMode === "recover" ? (
            <>
              <label className="block">
                <span className="text-xs font-medium text-muted">Email</span>
                <Input
                  className="mt-1.5"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  disabled={recoverSent}
                  autoFocus={!recoverSent}
                />
              </label>
              {recoverSent ? (
                <>
                  <label className="block">
                    <span className="text-xs font-medium text-muted">Reset code</span>
                    <Input
                      className="mt-1.5 text-center font-mono text-lg tracking-[0.5em]"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      autoFocus
                    />
                    {recoverDelivery === "in-app" && code ? (
                      <span className="mt-2 block rounded-md border border-dashed border-border bg-elevated px-3 py-2 text-xs text-muted">
                        In-app inbox · code{" "}
                        <button
                          type="button"
                          className="font-mono text-ice"
                          onClick={() => setCode(code)}
                        >
                          {code}
                        </button>{" "}
                        (no mail provider configured)
                      </span>
                    ) : recoverDelivery === "wire" ? (
                      <span className="mt-2 block rounded-md border border-dashed border-border bg-elevated px-3 py-2 text-xs text-muted">
                        wire.com emailed the code to this address — it can take a minute.
                      </span>
                    ) : null}
                  </label>
                  <label className="block">
                    <span className="text-xs font-medium text-muted">New password</span>
                    <Input
                      className="mt-1.5"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="At least 8 characters"
                      autoComplete="new-password"
                    />
                  </label>
                </>
              ) : null}
            </>
          ) : (
            <>
              {currentMode === "signin" ? (
                <div
                  role="tablist"
                  aria-label="Sign-in backend"
                  className="flex rounded-full border border-border bg-elevated p-1"
                >
                  {(["local", "wire"] as const).map((p) => (
                    <button
                      key={p}
                      type="button"
                      role="tab"
                      aria-selected={provider === p}
                      onClick={() => {
                        setProvider(p);
                        clearError();
                      }}
                      className={cn(
                        "flex-1 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                        provider === p ? "bg-accent text-accent-fg" : "text-muted",
                      )}
                    >
                      {p === "local" ? "This backend" : "wire.com"}
                    </button>
                  ))}
                </div>
              ) : null}
              <label className="block">
                <span className="text-xs font-medium text-muted">
                  {provider === "wire" && currentMode === "signin"
                    ? "wire.com email or @handle"
                    : "Email"}
                </span>
                <Input
                  className="mt-1.5"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={
                    provider === "wire" && currentMode === "signin"
                      ? "you@wire.com or @yourhandle"
                      : "you@example.com"
                  }
                  autoComplete="email"
                  autoFocus={currentMode === "signin"}
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-muted">Password</span>
                <Input
                  className="mt-1.5"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={currentMode === "register" ? "At least 8 characters" : "••••••••"}
                  autoComplete={
                    currentMode === "register" ? "new-password" : "current-password"
                  }
                />
              </label>
            </>
          )}

          {error ? <p className="text-sm text-danger">{error}</p> : null}

          <Button type="submit" className="w-full" disabled={!canSubmit}>
            {busy ? "Working…" : submitLabel}
            {currentMode === "register" ? <ShieldCheck className="ml-2 size-4" /> : null}
            {currentMode === "signin" ? <KeyRound className="ml-2 size-4" /> : null}
            {currentMode === "activate" ? <MailCheck className="ml-2 size-4" /> : null}
            {currentMode === "recover" ? <MailCheck className="ml-2 size-4" /> : null}
          </Button>
        </form>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
          {currentMode === "signin" ? (
            <button
              type="button"
              className="cursor-pointer underline-offset-4 hover:text-fg hover:underline"
              onClick={() => switchMode("register")}
            >
              New here? Create an account
            </button>
          ) : (
            <button
              type="button"
              className="cursor-pointer underline-offset-4 hover:text-fg hover:underline"
              onClick={() => {
                clearError();
                dismissActivation();
                setRecoverSent(false);
                setRecoverDelivery(null);
                setMode("signin");
              }}
            >
              {currentMode === "recover" ? "Back to sign in" : "Have an account? Sign in"}
            </button>
          )}
          {currentMode === "signin" ? (
            <button
              type="button"
              className="cursor-pointer underline-offset-4 hover:text-fg hover:underline"
              onClick={() => {
                clearError();
                dismissActivation();
                setRecoverSent(false);
                setRecoverDelivery(null);
                setMode("recover");
              }}
            >
              Forgot sign-in details?
            </button>
          ) : (
            <button
              type="button"
              className="cursor-pointer underline-offset-4 hover:text-fg hover:underline"
              onClick={() => void connectWire()}
            >
              Retry link
            </button>
          )}
        </div>

        <p className="mt-5 text-xs leading-relaxed text-subtle">
          Connects to wire.com. Built for GrapheneOS &amp; custom ROMs, and Android devices with or
          without Google Play Services.
          {currentMode === "recover" ? (
            <>
              {" "}
              Account hosted on wire.com?{" "}
              <a
                href="https://app.wire.com/"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-4 hover:text-fg"
              >
                Reset it directly at wire.com
              </a>
              .
            </>
          ) : null}
        </p>
        {status === "checking" ? (
          <p className="mt-2 text-xs text-subtle">Checking session…</p>
        ) : null}
      </section>
    </main>
  );
}
