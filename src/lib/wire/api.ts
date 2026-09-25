/**
 * The Wire-compatible API surface, as server functions.
 *
 * Endpoint names and payloads follow Wire's public API (`/register`,
 * `/activation/code`, `/login`, `/access`, `/self`, `/connections`,
 * `/users`, `/mls/key-packages`, `/conversations`, `/otr/messages`,
 * `/otr/welcome`) so the client code reads like a Wire client.
 *
 * This file must stay importable from the browser: only `createServerFn`,
 * the middleware and pure types are imported statically — every handler
 * dynamically imports its server-only implementation.
 */
import { createServerFn } from "@tanstack/react-start";
import { wireAuthMiddleware } from "./middleware";
import type {
  WireAuthResult,
  WireClientInfo,
  WireConnection,
  WireConversation,
  WireKeyPackage,
  WireKeyPackageBody,
  WireLoginInput,
  WireMessageRow,
  WireRecoverConfirmResult,
  WireRecoverRequestResult,
  WireRegisterInput,
  WireRegisterResult,
  WireSessionUser,
  WireUser,
  WireWelcomeRow,
} from "./types";

// ── Unauthenticated: credentials ─────────────────────────────────────────────

/** `POST /register` — create an account pending email activation. */
export const wireRegister = createServerFn({ method: "POST" })
  .validator((input: WireRegisterInput) => input)
  .handler(async ({ data }): Promise<WireRegisterResult> => {
    const { registerUser } = await import("./accounts.server");
    return registerUser(data);
  });

/** `PUT /activation/code` — confirm the email and activate the account. */
export const wireActivate = createServerFn({ method: "POST" })
  .validator((input: { email: string; code: string }) => input)
  .handler(async ({ data }) => {
    const { activateAccount } = await import("./accounts.server");
    return activateAccount(data.email, data.code);
  });

/** Step 1 of "forgot sign-in details?" — send the reset code. */
export const wireRecoverRequest = createServerFn({ method: "POST" })
  .validator((input: { email: string }) => input)
  .handler(async ({ data }): Promise<WireRecoverRequestResult> => {
    const { requestPasswordReset } = await import("./recover.server");
    return requestPasswordReset(data.email);
  });

/** Step 2 — verify the code and store the new password. */
export const wireRecoverConfirm = createServerFn({ method: "POST" })
  .validator((input: { email: string; code: string; password: string }) => input)
  .handler(async ({ data }): Promise<WireRecoverConfirmResult> => {
    const { confirmPasswordReset } = await import("./recover.server");
    return confirmPasswordReset(data);
  });

/** `POST /login` — email + password -> token pair. */
export const wireLogin = createServerFn({ method: "POST" })
  .validator((input: WireLoginInput & { clientId?: string | null }) => input)
  .handler(async ({ data }): Promise<WireAuthResult> => {
    const { loginUser } = await import("./accounts.server");
    return loginUser(data);
  });

/**
 * `POST /login` **against wire.com** — sign in with an account that lives on
 * Wire's production backend. The server mirrors the profile locally and issues
 * this app's own session, so everything downstream is unchanged.
 */
export const wireRemoteLogin = createServerFn({ method: "POST" })
  .validator((input: WireLoginInput & { clientId?: string | null }) => input)
  .handler(async ({ data }): Promise<WireAuthResult> => {
    const { remoteLogin } = await import("./remote.server");
    return remoteLogin(data);
  });

/** `POST /access` — refresh the access token. */
export const wireRefresh = createServerFn({ method: "POST" })
  .validator((input: { refreshToken: string }) => input)
  .handler(async ({ data }): Promise<WireAuthResult> => {
    const { refreshSession } = await import("./accounts.server");
    return refreshSession(data.refreshToken);
  });

// ── Authenticated: account / device ──────────────────────────────────────────

/** `DELETE /access` — revoke this session server-side. */
export const wireLogout = createServerFn({ method: "POST" })
  .middleware([wireAuthMiddleware])
  .handler(async () => {
    const { logoutSession } = await import("./accounts.server");
    // The token itself was already verified by the middleware; revoke by hash.
    const { getWireAccessToken } = await import("./session");
    await logoutSession(getWireAccessToken());
  });

/** `GET /self` */
export const wireGetSelf = createServerFn({ method: "GET" })
  .middleware([wireAuthMiddleware])
  .handler(async ({ context }): Promise<WireSessionUser> => {
    const { getSelf } = await import("./accounts.server");
    return getSelf(context.wireUserId);
  });

/** `PUT /self` — update name / handle / accent / locale. */
export const wireUpdateSelf = createServerFn({ method: "POST" })
  .middleware([wireAuthMiddleware])
  .validator((input: { name?: string; handle?: string; accentId?: number; locale?: string }) => input)
  .handler(async ({ context, data }): Promise<WireSessionUser> => {
    const { updateSelf } = await import("./accounts.server");
    return updateSelf(context.wireUserId, data);
  });

/** `POST /clients` + `POST /mls/key-packages` — register this device. */
export const wireRegisterDevice = createServerFn({ method: "POST" })
  .middleware([wireAuthMiddleware])
  .validator(
    (input: {
      clientId: string;
      label: string;
      model: string;
      class: string;
      fingerprint: string;
      packages: WireKeyPackageBody[];
    }) => input,
  )
  .handler(
    async ({ context, data }): Promise<{ client: WireClientInfo; packageCount: number }> => {
      const { registerDevice } = await import("./accounts.server");
      return registerDevice(context.wireUserId, data);
    },
  );

/** `POST /mls/key-packages/claim` — pop key packages for a welcome. */
export const wireClaimKeyPackages = createServerFn({ method: "POST" })
  .middleware([wireAuthMiddleware])
  .validator((input: { userIds: string[] }) => input)
  .handler(async ({ data }): Promise<WireKeyPackage[]> => {
    const { claimKeyPackages } = await import("./accounts.server");
    return claimKeyPackages(data.userIds);
  });

/** `GET /mls/key-packages` — how many unconsumed packages peers can still claim. */
export const wireKeyPackageCount = createServerFn({ method: "GET" })
  .middleware([wireAuthMiddleware])
  .handler(async ({ context }): Promise<{ count: number }> => {
    const { keyPackageCount } = await import("./accounts.server");
    return { count: await keyPackageCount(context.wireUserId) };
  });

// ── Authenticated: directory & contacts ──────────────────────────────────────

/** `GET /users?query=` — directory lookup (handle / name / email prefix). */
export const wireSearchUsers = createServerFn({ method: "POST" })
  .middleware([wireAuthMiddleware])
  .validator((input: { query: string }) => input)
  .handler(async ({ context, data }): Promise<WireUser[]> => {
    const { searchUsers } = await import("./social.server");
    return searchUsers(context.wireUserId, data.query);
  });

/** `GET /users/{id}` */
export const wireGetUser = createServerFn({ method: "POST" })
  .middleware([wireAuthMiddleware])
  .validator((input: { userId: string }) => input)
  .handler(async ({ context, data }): Promise<WireUser> => {
    const { getUser } = await import("./social.server");
    return getUser(context.wireUserId, data.userId);
  });

/** `GET /connections` */
export const wireGetConnections = createServerFn({ method: "GET" })
  .middleware([wireAuthMiddleware])
  .handler(async ({ context }): Promise<WireConnection[]> => {
    const { listConnections } = await import("./social.server");
    return listConnections(context.wireUserId);
  });

/** `POST /connections` — send a contact request. */
export const wireCreateConnection = createServerFn({ method: "POST" })
  .middleware([wireAuthMiddleware])
  .validator((input: { userId: string; message?: string }) => input)
  .handler(async ({ context, data }): Promise<WireConnection[]> => {
    const { createConnection } = await import("./social.server");
    return createConnection(context.wireUserId, data.userId, data.message);
  });

/** `PUT /connections/{id}` — accept / ignore / block / cancel. */
export const wireUpdateConnection = createServerFn({ method: "POST" })
  .middleware([wireAuthMiddleware])
  .validator(
    (input: { userId: string; action: "accept" | "ignore" | "block" | "cancel" }) => input,
  )
  .handler(async ({ context, data }): Promise<WireConnection[]> => {
    const { updateConnection } = await import("./social.server");
    return updateConnection(context.wireUserId, data.userId, data.action);
  });

// ── Authenticated: conversations & MLS messaging ─────────────────────────────

/** `GET /conversations` */
export const wireGetConversations = createServerFn({ method: "GET" })
  .middleware([wireAuthMiddleware])
  .handler(async ({ context }): Promise<WireConversation[]> => {
    const { listConversations } = await import("./messaging.server");
    return listConversations(context.wireUserId);
  });

/** `POST /conversations` — start a 1:1 or group conversation. */
export const wireCreateConversation = createServerFn({ method: "POST" })
  .middleware([wireAuthMiddleware])
  .validator((input: { otherUserIds: string[]; name?: string }) => input)
  .handler(async ({ context, data }): Promise<WireConversation> => {
    const { createConversation } = await import("./messaging.server");
    return createConversation(context.wireUserId, data.otherUserIds, data.name);
  });

/** `POST /conversations/{id}/otr/welcome` — deliver sealed epoch secrets. */
export const wirePostWelcomes = createServerFn({ method: "POST" })
  .middleware([wireAuthMiddleware])
  .validator(
    (input: {
      conversationId: string;
      epoch: number;
      recipients: { userId: string; clientId: string; payload: string }[];
    }) => input,
  )
  .handler(async ({ context, data }): Promise<{ delivered: number }> => {
    const { postWelcomes } = await import("./messaging.server");
    return postWelcomes(context.wireUserId, data);
  });

/** `GET /otr/welcome` — welcomes waiting for my device. */
export const wireGetWelcomes = createServerFn({ method: "GET" })
  .middleware([wireAuthMiddleware])
  .handler(async ({ context }): Promise<WireWelcomeRow[]> => {
    const { fetchWelcomes } = await import("./messaging.server");
    return fetchWelcomes(context.wireUserId);
  });

/** `POST /conversations/{id}/otr/messages` — store one encrypted message. */
export const wirePostMessage = createServerFn({ method: "POST" })
  .middleware([wireAuthMiddleware])
  .validator(
    (input: {
      id: string;
      conversationId: string;
      senderClient: string;
      epoch: number;
      contentType?: string;
      payload: string;
    }) => input,
  )
  .handler(async ({ context, data }): Promise<WireMessageRow> => {
    const { postMessage } = await import("./messaging.server");
    return postMessage(context.wireUserId, data);
  });

/** `GET /conversations/{id}/messages` — ciphertext since a timestamp. */
export const wireGetMessages = createServerFn({ method: "POST" })
  .middleware([wireAuthMiddleware])
  .validator((input: { conversationId: string; since?: string | null; limit?: number }) => input)
  .handler(async ({ context, data }): Promise<WireMessageRow[]> => {
    const { fetchMessages } = await import("./messaging.server");
    return fetchMessages(context.wireUserId, data);
  });
