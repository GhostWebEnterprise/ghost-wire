/**
 * Auth middleware for the Wire-compatible server functions — the fork's
 * equivalent of `@/lib/auth/middleware`, resolving Wire's `Authorization:
 * Bearer <access_token>` instead of the platform session cookie.
 *
 *   export const wireGetSelf = createServerFn({ method: "GET" })
 *     .middleware([wireAuthMiddleware])
 *     .handler(async ({ context }) => { ... context.wireUserId ... });
 *
 * The token lives in `localStorage` (the same place the Wire web client keeps
 * its token pair) and is forwarded by the `.client` hook, so call sites never
 * thread it. A missing/expired token throws a 401 with message "Unauthorized"
 * — never a fallback identity.
 *
 * Dual client/server module: the client hook only touches `./session` (browser
 * storage); the server hook dynamically imports the `.server` modules so no
 * Node code lands in the browser bundle.
 */
import { createMiddleware } from "@tanstack/react-start";

export const wireAuthMiddleware = createMiddleware({ type: "function" })
  .client(async ({ next }) => {
    const { getWireAccessToken } = await import("./session");
    return next({ sendContext: { accessToken: getWireAccessToken() ?? undefined } });
  })
  .server(async ({ next, context }) => {
    // Same sibling-isolation guard the platform auth middleware applies.
    const { assertSameSiteRequest } = await import("@/lib/auth/isolation.server");
    const { requireWireUser } = await import("./accounts.server");
    assertSameSiteRequest();
    const identity = await requireWireUser(context.accessToken);
    return next({
      context: {
        wireUserId: identity.userId,
        wireClientId: identity.clientId,
      },
    });
  });
