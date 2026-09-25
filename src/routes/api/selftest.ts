import { createFileRoute } from "@tanstack/react-router";

/**
 * Dev-only self-test of the contacts path built on Wire's schema.
 *
 * Walks the exact server functions the UI calls — register → activation →
 * login → directory search → connection request → accept → MLS conversation →
 * ciphertext round trip — against the running database, then deletes every row
 * it created, so the preview's directory never keeps test accounts around.
 *
 * Only answers in `vite dev`; deployed builds return 404.
 */

interface Step {
  name: string;
  ok: boolean;
  detail?: string;
}

interface CleanupReport {
  conversations: number;
  users: number;
}

async function runSelfTest(): Promise<Response> {
  const steps: Step[] = [];
  const userIds: string[] = [];
  const conversationIds: string[] = [];
  let ok = true;

  const check = (name: string, condition: boolean, detail?: string) => {
    steps.push({ name, ok: condition, detail });
    if (!condition) ok = false;
    return condition;
  };

  try {
    const { registerUser, activateAccount, loginUser, registerDevice } = await import(
      "@/lib/wire/accounts.server"
    );
    const { searchUsers, createConnection, updateConnection, listConnections } = await import(
      "@/lib/wire/social.server"
    );
    const { createConversation, postMessage, fetchMessages } = await import(
      "@/lib/wire/messaging.server"
    );

    const stamp = Date.now().toString(36);
    const password = "selftest-pass-9";
    const aliceInput = {
      name: "Selftest Alice",
      email: `st.alice.${stamp}@example.com`,
      password,
      handle: `sta${stamp}`.slice(0, 21),
    };
    const bobInput = {
      name: "Selftest Bob",
      email: `st.bob.${stamp}@example.com`,
      password,
      handle: `stb${stamp}`.slice(0, 21),
    };

    // ── 1. Accounts: Wire's register → activate → login ─────────────────────
    const aliceReg = await registerUser(aliceInput);
    if (aliceReg.ok) userIds.push(aliceReg.user.id);
    const aliceCode = aliceReg.ok ? aliceReg.activation.code : undefined;
    if (
      !check(
        "register Alice (POST /register)",
        aliceReg.ok && Boolean(aliceCode),
        aliceReg.ok
          ? `delivery=${aliceReg.activation.delivery}`
          : aliceReg.error,
      )
    ) {
      throw new Error("registration failed — remaining steps need accounts");
    }

    const bobReg = await registerUser(bobInput);
    if (bobReg.ok) userIds.push(bobReg.user.id);
    const bobCode = bobReg.ok ? bobReg.activation.code : undefined;
    if (
      !check(
        "register Bob (POST /register)",
        bobReg.ok && Boolean(bobCode),
        bobReg.ok ? `delivery=${bobReg.activation.delivery}` : bobReg.error,
      )
    ) {
      throw new Error("registration failed — remaining steps need accounts");
    }

    if (!aliceReg.ok || !bobReg.ok) throw new Error("registration failed — remaining steps need accounts");
    const aliceId = aliceReg.user.id;
    const bobId = bobReg.user.id;

    const aliceActivated = await activateAccount(aliceInput.email, aliceCode!);
    const bobActivated = await activateAccount(bobInput.email, bobCode!);
    if (
      !check(
        "activation codes confirm (PUT /activation/code)",
        aliceActivated.ok && bobActivated.ok,
        aliceActivated.ok && bobActivated.ok ? "both accounts active" : "bad or expired code",
      )
    ) {
      throw new Error("activation failed");
    }

    const aliceLogin = await loginUser({ email: aliceInput.email, password });
    const bobLogin = await loginUser({ email: bobInput.email, password });
    if (
      !check(
        "login issues token pairs (POST /login)",
        aliceLogin.ok && bobLogin.ok,
        aliceLogin.ok && bobLogin.ok ? "access + refresh issued" : "credential rejected",
      )
    ) {
      throw new Error("login failed");
    }

    // ── 2. Directory lookup (GET /users?query=) ─────────────────────────────
    const found = await searchUsers(aliceId, bobInput.handle);
    const bobHit = found.find((u) => u.id === bobId);
    check(
      "directory search finds Bob by handle",
      Boolean(bobHit),
      bobHit ? `@${bobHit.handle} · email=${bobHit.email} · status=${bobHit.connectionStatus}` : "no match",
    );
    check(
      "unconnected directory entries mask the email",
      Boolean(bobHit?.email.includes("***")),
      bobHit?.email,
    );

    // ── 3. Guard: no conversation before the connection is accepted ─────────
    let guardCode: string | null = null;
    try {
      await createConversation(aliceId, [bobId]);
    } catch (err) {
      guardCode = err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : null;
    }
    check(
      "conversation blocked until contacts are accepted",
      guardCode === "not_connected",
      guardCode ? `threw code=${guardCode}` : "conversation was allowed too early",
    );

    // ── 4. Connection request → pending → accept ────────────────────────────
    const afterRequest = await createConnection(aliceId, bobId, "selftest request");
    const outgoing = afterRequest.find((c) => c.peer.id === bobId);
    check(
      "contact request lands as pending (POST /connections)",
      outgoing?.status === "pending" && outgoing.direction === "outgoing",
      `status=${outgoing?.status} direction=${outgoing?.direction}`,
    );

    const bobView = await listConnections(bobId);
    const incoming = bobView.find((c) => c.peer.id === aliceId);
    check(
      "Bob sees the incoming request (GET /connections)",
      incoming?.status === "pending" && incoming.direction === "incoming",
      `status=${incoming?.status} direction=${incoming?.direction}`,
    );

    const afterAccept = await updateConnection(bobId, aliceId, "accept");
    const acceptedForBob = afterAccept.find((c) => c.peer.id === aliceId);
    const aliceView = await listConnections(aliceId);
    const acceptedForAlice = aliceView.find((c) => c.peer.id === bobId);
    check(
      "accept flips both sides to accepted (PUT /connections/{id})",
      acceptedForBob?.status === "accepted" && acceptedForAlice?.status === "accepted",
      `bob=${acceptedForBob?.status} alice=${acceptedForAlice?.status}`,
    );
    check(
      "accepted contacts reveal the real email",
      Boolean(acceptedForAlice?.peer.email.endsWith("@example.com")),
      acceptedForAlice?.peer.email,
    );

    // ── 5. Conversation + MLS ciphertext round trip ─────────────────────────
    const conversation = await createConversation(aliceId, [bobId]);
    conversationIds.push(conversation.id);
    const bobConversation = await createConversation(bobId, [aliceId]);
    check(
      "1:1 conversation is idempotent for both sides",
      bobConversation.id === conversation.id,
      `alice=${conversation.id} bob=${bobConversation.id}`,
    );

    const aliceDevice = await registerDevice(aliceId, {
      clientId: `st-alice-${stamp}`.slice(0, 32),
      label: "Selftest device",
      model: "Selftest",
      class: "desktop",
      fingerprint: "SELFTEST FINGERPRINT",
      packages: [],
    });
    check(
      "device registration (POST /clients)",
      aliceDevice.client.userId === aliceId,
      `client=${aliceDevice.client.id} packages=${aliceDevice.packageCount}`,
    );

    const payload = JSON.stringify({ v: 1, type: "text", body: "selftest", at: Date.now() });
    const sent = await postMessage(aliceId, {
      id: "",
      conversationId: conversation.id,
      senderClient: aliceDevice.client.id,
      epoch: conversation.epoch,
      payload,
    });
    const inbox = await fetchMessages(bobId, { conversationId: conversation.id });
    check(
      "Bob fetches Alice's ciphertext (GET /conversations/{id}/messages)",
      inbox.some((m) => m.id === sent.id && m.payload === payload),
      `${inbox.length} message(s) readable by Bob`,
    );
  } catch (err) {
    ok = false;
    steps.push({
      name: "self-test aborted",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // ── Cleanup: remove everything this run created, in FK order ──────────────
  // The catch above never rethrows, so cleanup always runs; nothing is
  // returned from inside a finally block.
  const cleanup: CleanupReport = { conversations: 0, users: 0 };
  try {
    const { getSql } = await import("@/lib/db");
    const sql = await getSql();
    for (const conversationId of conversationIds) {
      await sql`delete from wire_messages where conversation_id = ${conversationId}`;
      await sql`delete from wire_welcomes where conversation_id = ${conversationId}`;
      await sql`delete from wire_conversation_members where conversation_id = ${conversationId}`;
      const gone = await sql`delete from wire_conversations where id = ${conversationId} returning id`;
      cleanup.conversations += gone.length;
    }
    for (const userId of userIds) {
      await sql`delete from wire_connections where from_user = ${userId} or to_user = ${userId}`;
      await sql`delete from wire_key_packages where user_id = ${userId}`;
      await sql`delete from wire_clients where user_id = ${userId}`;
      await sql`delete from wire_sessions where user_id = ${userId}`;
      const gone = await sql`delete from wire_users where id = ${userId} returning id`;
      cleanup.users += gone.length;
    }
    steps.push({
      name: "cleanup removed the test rows",
      ok: true,
      detail: `${cleanup.users} account(s), ${cleanup.conversations} conversation(s)`,
    });
  } catch (err) {
    steps.push({
      name: "cleanup removed the test rows",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
    ok = false;
  }
  return Response.json({ ok, steps });
}

const handle = (): Promise<Response> =>
  import.meta.env.DEV
    ? runSelfTest()
    : Promise.resolve(new Response("Not found", { status: 404 }));

export const Route = createFileRoute("/api/selftest")({
  server: { handlers: { GET: handle } },
});
