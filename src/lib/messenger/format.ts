const TIME = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

export function formatTime(at: number): string {
  return TIME.format(at);
}

export function formatListTime(at: number): string {
  const diff = Date.now() - at;
  if (diff < 60_000) return "now";
  if (diff < 24 * 60 * 60 * 1000 && new Date(at).getDate() === new Date().getDate()) {
    return TIME.format(at);
  }
  if (diff < 7 * 24 * 60 * 60 * 1000) {
    return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(at);
  }
  return DAY.format(at);
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function ttlLabel(hours: number): string {
  if (hours === 0) return "Keep";
  if (hours === 1) return "1h";
  if (hours === 24) return "24h";
  if (hours === 72) return "72h";
  return `${hours}h`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "GW";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
