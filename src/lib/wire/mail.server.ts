/**
 * Activation-code delivery for Wire-style registration.
 *
 * Uses **Resend** when `RESEND_API_KEY` is configured (set it under
 * Settings → Environment together with `RESEND_EMAIL_FROM`), calling the REST
 * API directly so no extra dependency is shipped. Without a key the code is
 * returned to the caller for the in-app "demo inbox" — registration still
 * completes in the live preview, it just doesn't leave the building.
 *
 * Server-only: reads server env vars.
 */

type Delivery = "email" | "in-app";

const RESEND_API_KEY = process.env.RESEND_API_KEY?.trim() || undefined;
const RESEND_FROM = process.env.RESEND_EMAIL_FROM?.trim() || "onboarding@resend.dev";

/** True when real email delivery is available in this environment. */
export function emailDeliveryConfigured(): boolean {
  return Boolean(RESEND_API_KEY);
}

/**
 * Send the activation code. Never throws — a mail failure downgrades to
 * in-app delivery so the account flow can still complete.
 */
export async function deliverActivationCode(
  email: string,
  name: string,
  code: string,
): Promise<Delivery> {
  if (!RESEND_API_KEY) return "in-app";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [email],
        subject: `Your ${name ? `${name} ` : ""}Wire activation code`,
        text: [
          `Your activation code is: ${code}`,
          "",
          "Enter it in GhostWire to finish creating your account.",
          "If you didn't request this, you can ignore this email.",
        ].join("\n"),
        html: `
          <div style="font-family:system-ui,sans-serif;line-height:1.5">
            <p>Hi ${escapeHtml(name || "there")},</p>
            <p>Your activation code is:</p>
            <p style="font-size:28px;letter-spacing:6px;font-weight:700">${code}</p>
            <p>Enter it in GhostWire to finish creating your account. The code
              expires in 15 minutes.</p>
          </div>`,
      }),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok ? "email" : "in-app";
  } catch {
    return "in-app";
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Send a password-reset code — same delivery split as activation: Resend when
 * configured, otherwise the in-app demo inbox so recovery completes in the
 * live preview.
 */
export async function deliverPasswordResetCode(
  email: string,
  name: string,
  code: string,
): Promise<Delivery> {
  if (!RESEND_API_KEY) return "in-app";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [email],
        subject: `Your ${name ? `${name} ` : ""}GhostWire password reset code`,
        text: [
          `Your password reset code is: ${code}`,
          "",
          "Enter it in GhostWire to choose a new password. It expires in 15 minutes.",
          "If you didn't request this, you can ignore this email.",
        ].join("\n"),
      }),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok ? "email" : "in-app";
  } catch {
    return "in-app";
  }
}
