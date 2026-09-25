import { cn } from "@/lib/utils";
import { initials } from "@/lib/messenger/format";

const hues = [
  "bg-avatar-1",
  "bg-avatar-2",
  "bg-avatar-3",
  "bg-avatar-4",
  "bg-avatar-5",
  "bg-avatar-6",
] as const;

export function GhostMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("text-accent", className)} aria-hidden>
      <circle cx="16" cy="16" r="11.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M16 7.5v6.5M16 18v6.5M7.5 16h6.5M18 16h6.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="16" cy="16" r="2.2" fill="currentColor" />
    </svg>
  );
}

export function PersonMark({
  name,
  hue,
  size = "md",
  verified,
}: {
  name: string;
  hue: number;
  size?: "sm" | "md" | "lg";
  verified?: boolean;
}) {
  const dim = size === "sm" ? "size-8 text-[10px]" : size === "lg" ? "size-14 text-base" : "size-10 text-xs";
  return (
    <span className="relative inline-flex shrink-0">
      <span
        className={cn(
          "inline-flex items-center justify-center rounded-full font-medium tracking-wide text-fg",
          hues[hue % hues.length],
          dim,
        )}
      >
        {initials(name)}
      </span>
      {verified ? (
        <span className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full bg-verified ring-2 ring-bg" />
      ) : null}
    </span>
  );
}
