/**
 * Locally verified peer fingerprints.
 *
 * MLS gives us each contact's device fingerprint; *verification* is the human
 * step of comparing it (in person, on a call). The result is this device's
 * local trust list — Wire keeps the same per-device trust state client side.
 */
const KEY = "ghostwire-verified-peers-v1";

function read(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** True when this device has verified the peer's fingerprint. */
export function isPeerVerified(peerId: string): boolean {
  return read().includes(peerId);
}

/** Add/remove a peer from this device's trust list. */
export function setPeerVerified(peerId: string, verified: boolean): void {
  const current = read();
  const next = verified
    ? [...new Set([...current, peerId])]
    : current.filter((id) => id !== peerId);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable — verification just won't persist */
  }
}
