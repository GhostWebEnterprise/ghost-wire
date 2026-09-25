/**
 * Password recovery behind "Forgot sign-in details?".
 *
 * - Local accounts: a Wire-style 6-digit code with a 15-minute expiry, sent
 *   through the same delivery split as registration (Resend, or the in-app
 *   demo inbox in the live preview).
 * - wire.com-mirrored accounts: brig's own `/password-reset` flow is proxied,
 *   so Wire emails the code to the address it has on file and the reset lands
 *   on wire.com itself — the local mirror's hash is kept in step afterwards.
 *
 * Server-only. Reached through the `./api` wrappers.
 */
import { getSql } from "@/lib/db";
import type { WireUserRow } from "./accounts.server";
import { activationCode, hashPassword } from "./core.server";
import { deliverPasswordResetCode } from "./mail.server";
import {
  isRemoteRow,
  remotePasswordResetComplete,
  remotePasswordResetRequest,
} from "./remote.server";
import type { WireRecoverConfirmResult, WireRecoverRequestResult } from "./types";

const RESET_TTL_MINUTES = 15;

/** Step 1 — send (or hand back) the reset code. */
export async function requestPasswordReset(
  email: string,
): Promise<WireRecoverRequestResult> {
  const sql = await getSql();
  const normalized = email.trim().toLowerCase();
  const rows = await sql<WireUserRow>`
    select * from wire_users where email = ${normalized} and status <> 'deleted'`;
  const row = rows[0];
  if (!row) {
    return {
      ok: false,
      error: "No account with that email on this backend — or reset it directly at wire.com.",
    };
  }
  if (isRemoteRow(row)) {
    // Real Wire account: brig sends the code to the inbox Wire has on file.
    await remotePasswordResetRequest(normalized);
    return { ok: true, delivery: "wire" };
  }
  const code = activationCode();
  const expires = new Date(Date.now() + RESET_TTL_MINUTES * 60 * 1000).toISOString();
  await sql`
    update wire_users
       set reset_code = ${code}, reset_expires = ${expires}, updated_at = now()
     where id = ${row.id}`;
  const delivery = await deliverPasswordResetCode(normalized, row.name, code);
  return delivery === "in-app"
    ? { ok: true, delivery: "in-app", code }
    : { ok: true, delivery: "email" };
}

/** Step 2 — verify the code and set the new password. */
export async function confirmPasswordReset(input: {
  email: string;
  code: string;
  password: string;
}): Promise<WireRecoverConfirmResult> {
  const password = input.password;
  if (password.length < 8) {
    return { ok: false, error: "Password must be at least 8 characters." };
  }
  const code = input.code.trim();
  if (!code) return { ok: false, error: "Enter the code from your email." };

  const sql = await getSql();
  const normalized = input.email.trim().toLowerCase();
  const rows = await sql<WireUserRow>`
    select * from wire_users where email = ${normalized} and status <> 'deleted'`;
  const row = rows[0];
  if (!row) {
    return { ok: false, error: "No account with that email on this backend." };
  }

  if (isRemoteRow(row)) {
    await remotePasswordResetComplete(normalized, code, password);
    const hash = await hashPassword(password);
    await sql`
      update wire_users
         set password_hash = ${hash}, reset_code = null, reset_expires = null,
             updated_at = now()
       where id = ${row.id}`;
    return { ok: true };
  }

  if (!row.reset_code || !row.reset_expires) {
    return { ok: false, error: "No reset pending for this email — request a code first." };
  }
  if (new Date(row.reset_expires).getTime() < Date.now()) {
    await sql`
      update wire_users set reset_code = null, reset_expires = null where id = ${row.id}`;
    return { ok: false, error: "That code expired — request a new one." };
  }
  if (row.reset_code !== code) {
    return { ok: false, error: "That code doesn't match." };
  }

  const hash = await hashPassword(password);
  await sql`
    update wire_users
       set password_hash = ${hash}, reset_code = null, reset_expires = null,
           email_verified = true, status = 'active',
           activation_code = null, activation_expires = null, updated_at = now()
     where id = ${row.id}`;
  // A reset invalidates every existing session, like Wire's own flow does.
  await sql`delete from wire_sessions where user_id = ${row.id}`;
  return { ok: true };
}
