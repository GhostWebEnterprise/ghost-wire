import { createFileRoute } from "@tanstack/react-router";
import { WIRE_BACKEND_HOST, type WireLinkProbe } from "@/lib/messenger/types";

const API_VERSION_URL = `https://${WIRE_BACKEND_HOST}/api-version`;
const TIMEOUT_MS = 6000;

/**
 * Live link check against Wire's production backend. Runs server-side so the
 * browser never needs CORS from wire.com and the endpoint stays reachable on
 * deploy. Read-only: a single GET of the public /api-version document.
 */
async function probeWire(): Promise<WireLinkProbe> {
  const started = Date.now();
  try {
    const res = await fetch(API_VERSION_URL, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return {
        ok: false,
        host: WIRE_BACKEND_HOST,
        checkedAt: Date.now(),
        latencyMs,
        error: `HTTP ${res.status}`,
      };
    }
    const data = (await res.json()) as {
      domain?: string;
      federation?: boolean;
      supported?: number[];
    };
    return {
      ok: true,
      host: WIRE_BACKEND_HOST,
      domain: data.domain,
      federation: data.federation,
      supported: data.supported,
      latencyMs,
      checkedAt: Date.now(),
    };
  } catch (err) {
    return {
      ok: false,
      host: WIRE_BACKEND_HOST,
      checkedAt: Date.now(),
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : "unreachable",
    };
  }
}

const handle = (): Promise<Response> => probeWire().then((probe) => Response.json(probe));

export const Route = createFileRoute("/api/wire")({
  server: { handlers: { GET: handle } },
});
