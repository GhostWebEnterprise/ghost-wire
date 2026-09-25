/**
 * Wire session storage on the client — the token pair the account API hands
 * out, kept in `localStorage` the way the Wire web client keeps its own.
 *
 * Safe to import from client code (no server deps). The middleware in
 * `./middleware` reads `getWireAccessToken()` to authenticate every
 * authenticated server function.
 */
import type { WireSession } from "./types";

const SESSION_KEY = "ghostwire-wire-session-v1";
/** Refresh this far ahead of expiry so a sync never races a dying token. */
const REFRESH_MARGIN_MS = 30_000;

let cached: WireSession | null | undefined;

function read(): WireSession | null {
  if (cached !== undefined) return cached;
  try {
    const raw = typeof window === "undefined" ? null : localStorage.getItem(SESSION_KEY);
    cached = raw ? (JSON.parse(raw) as WireSession) : null;
  } catch {
    cached = null;
  }
  return cached;
}

/** The stored session, or `null` when signed out. */
export function getWireSession(): WireSession | null {
  return read();
}

/** Persist a session (after login / refresh). */
export function setWireSession(session: WireSession): void {
  cached = session;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    /* storage unavailable — the in-memory copy still serves this page */
  }
}

/** Drop the local session (sign-out or failed refresh). */
export function clearWireSession(): void {
  cached = undefined;
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * The access token for the auth middleware. Returns the stored token even if
 * it looks expired — the server is the authority on that, and a stale token
 * produces a clean 401 the caller can react to.
 */
export function getWireAccessToken(): string | null {
  return read()?.tokens.accessToken ?? null;
}

/**
 * Return a usable session, transparently refreshing the access token when it
 * is within `REFRESH_MARGIN_MS` of expiry. Returns `null` (and clears the
 * stored session) when the refresh is rejected — the caller should sign out.
 */
export async function ensureFreshSession(): Promise<WireSession | null> {
  const session = read();
  if (!session) return null;
  if (session.tokens.expiresAt - Date.now() > REFRESH_MARGIN_MS) return session;
  try {
    const { wireRefresh } = await import("./api");
    const result = await wireRefresh({ data: { refreshToken: session.tokens.refreshToken } });
    if (!result.ok) {
      clearWireSession();
      return null;
    }
    // Keep the profile fresh while we're here.
    const next: WireSession = { ...result.session, clientId: session.clientId };
    setWireSession(next);
    return next;
  } catch {
    // Network hiccup: keep the existing session and let the caller retry.
    return session;
  }
}
