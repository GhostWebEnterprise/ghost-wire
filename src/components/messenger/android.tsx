import { Battery, Lock, Wifi } from "lucide-react";
import { GhostMark } from "@/components/messenger/mark";
import { useVault } from "@/lib/messenger/store";

export function StatusBar() {
  const shield = useVault((s) => s.settings.screenshotShield);
  const wire = useVault((s) => s.wire);
  const now = new Date();
  const time = now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="flex h-7 shrink-0 items-center justify-between bg-bg px-3 text-[11px] tabular-nums text-muted">
      <span>{time}</span>
      <span className="flex items-center gap-1.5 font-medium tracking-[0.14em] text-subtle uppercase">
        <GhostMark className="size-3" />
        GhostWire
      </span>
      <span className="flex items-center gap-2">
        {shield ? <Lock className="size-3 text-ice" /> : null}
        <span
          className="flex items-center gap-1"
          title={
            wire.phase === "online"
              ? `wire.com linked · ${wire.probe?.latencyMs ?? "—"}ms`
              : wire.phase === "connecting"
                ? "Linking to wire.com…"
                : `wire.com unreachable${wire.probe?.error ? ` · ${wire.probe.error}` : ""}`
          }
        >
          <span
            className={`size-1.5 rounded-full ${
              wire.phase === "online"
                ? "bg-verified"
                : wire.phase === "connecting"
                  ? "bg-warn"
                  : "bg-danger"
            }`}
          />
          <span className="font-mono text-[10px] tracking-wide text-subtle">
            {wire.phase === "online" ? "wire.com" : wire.phase === "connecting" ? "linking" : "offline"}
          </span>
        </span>
        <Wifi className="size-3" />
        <Battery className="size-3.5" />
      </span>
    </div>
  );
}
