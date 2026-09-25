/**
 * Auth-flow QA: drives the real UI end to end against the dev preview.
 *
 *   node scripts/qa-auth.mjs [baseURL]
 *
 * Covers: wire.com link probe on the sign-in screen, registration + activation,
 * sign-out, sign-in to an EXISTING account, the wire.com provider (graceful
 * error for bad credentials), "Forgot sign-in details?" (request → code → new
 * password) and sign-in with the reset password. Screenshots land in
 * /workspace/screenshots/qa-NN-*.png; throws (exit 1) on any failed assertion
 * or console/page error.
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://127.0.0.1:8080";
const SHOTS = "screenshots";
const SESSION_KEY = "ghostwire-wire-session-v1";
const stamp = Date.now();
const EMAIL = `qa+${stamp}@ghostwire.test`;
const PASSWORD = "gh0st-wire-pass";
const NEW_PASSWORD = "rotated-pass-99";

const problems = [];
const note = (msg) => console.log(`✓ ${msg}`);
const fail = (msg) => {
  throw new Error(msg);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("console", (m) => {
  if (m.type() === "error") problems.push(`console: ${m.text()}`);
});
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
// Destructive confirmations (Destroy vault) are part of the scripted flow.
page.on("dialog", (d) => void d.accept());
// Downloads are collected instead of awaited per-event: a pending waitForEvent
// that loses a race with a failure throws as an unhandled rejection.
const downloads = [];
page.on("download", (d) => downloads.push(d));

const shot = (name) => page.screenshot({ path: `${SHOTS}/qa-${name}.png` });
const heading = (name) => page.getByRole("heading", { name, exact: true });
const submit = () => page.locator("form button[type=submit]");
const session = () => page.evaluate((k) => localStorage.getItem(k), SESSION_KEY);
const sessionUser = async () => {
  const raw = await session();
  return raw ? JSON.parse(raw)?.user ?? null : null;
};
/** Signed-in landing: onboarding (fresh vault) or straight into the shell. */
const landed = () =>
  page.waitForFunction(
    () =>
      document.body.innerText.includes("Independent messenger. Connects to wire.com.") ||
      Boolean(document.querySelector('button[aria-label="Contacts"]')),
    null,
    { timeout: 30_000 },
  );
const clearSession = async () => {
  await page.evaluate((k) => localStorage.removeItem(k), SESSION_KEY);
  await page.reload({ waitUntil: "domcontentloaded" });
};
/** The Vault panel holds the backup controls — make sure it is the open rail. */
const backupButton = () => page.getByRole("button", { name: "Create backup", exact: true });
/** The vault's file picker (the chat pane has its own type=file — match ours). */
const backupFileInput = () => page.locator('input[accept*="gwbak"]');
const openVaultPanel = async () => {
  if ((await backupButton().count()) > 0) return;
  await page.locator('button[aria-label="Vault"]').first().click();
  await backupButton().waitFor({ timeout: 15_000 });
};

try {
  // 1 ── front door renders and the wire.com probe actually runs
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await heading("Sign in to Wire").waitFor({ timeout: 30_000 });
  await page.getByText("wire.com linked", { exact: false }).waitFor({ timeout: 20_000 });
  note("sign-in screen renders; wire.com link probe reports online");
  await shot("01-signin");

  // 2 ── register a new account (Wire's pending → activation flow)
  await page.getByRole("button", { name: "New here? Create an account", exact: true }).click();
  await heading("Create your Wire account").waitFor({ timeout: 10_000 });
  await page.getByLabel("Name", { exact: true }).fill("QA Operator");
  await page.getByLabel("Email", { exact: true }).fill(EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await shot("02-register");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await heading("Confirm your email").waitFor({ timeout: 20_000 });
  const activationNotice = page.getByText("In-app inbox", { exact: false });
  await activationNotice.waitFor({ timeout: 10_000 });
  const codeButton = activationNotice.locator("button").first();
  const activationCode = (await codeButton.textContent())?.trim();
  if (!activationCode) fail("no in-app activation code was shown");
  note(`registered ${EMAIL} → activation code ${activationCode}`);
  await shot("03-activation");
  await codeButton.click();
  await page.getByRole("button", { name: "Activate & continue", exact: true }).click();

  // 3 ── activation signs the fresh account in
  await heading("Independent messenger. Connects to wire.com.").waitFor({ timeout: 30_000 });
  if (!(await session())) fail("no session was stored after activation + sign-in");
  note("activation completed and the new account signed in");
  await shot("04-onboarding");

  // 4 ── finish onboarding, then sign out with the real control
  await page.getByRole("button", { name: "Create local vault", exact: true }).click();
  await page.locator('button[aria-label="Contacts"]').first().waitFor({ timeout: 20_000 });
  note("local vault created; main shell is up");
  await shot("05-shell");

  // 4b ── MLS device registration: five UNIQUE key packages, no pkey crash.
  // (The upload used to die on wire_key_packages_pkey — every package was the
  // same content digest — which left the pool at 0 and flashed a raw Postgres
  // error toast in the shell.)
  await page.locator('button[aria-label="Vault"]').first().click();
  await page.getByText("5 key packages", { exact: false }).waitFor({ timeout: 20_000 });
  const shellText = await page.evaluate(() => document.body.innerText);
  if (/duplicate key value/i.test(shellText)) fail("key-package upload hit a pkey violation");
  note("MLS device registered · 5 key packages ready, no duplicate-key error");
  await shot("06-vault-keys");
  await page.getByRole("button", { name: "Sync keys", exact: true }).click();
  await page.getByText("Device registered", { exact: false }).waitFor({ timeout: 15_000 });
  note("Sync keys re-check is idempotent");

  // 4c ── Differential backup test: put a UNIQUE conversation in the vault
  // (a sealed channel), back everything up, then destroy the vault and bring
  // that conversation back with the recovery key — after proving a wrong key
  // is rejected.
  await page.locator('button[aria-label="Chats"]').first().click();
  await page.locator('button[aria-label="New sealed channel"]').click();
  await page.getByRole("button", { name: "Generate invite", exact: true }).click();
  await page.getByText("Copy invite", { exact: false }).waitFor({ timeout: 10_000 });
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Generate invite", exact: true })
    .waitFor({ state: "detached", timeout: 10_000 });
  note("sealed channel created — a conversation no reseed can recreate");

  await openVaultPanel();
  await page.getByRole("button", { name: "Create backup", exact: true }).click();
  let download = null;
  for (let i = 0; !download && i < 60; i += 1) {
    download = downloads[0] ?? null;
    if (!download) await page.waitForTimeout(500);
  }
  if (!download) {
    const state = await page.evaluate(() => ({
      url: location.href,
      text: document.body.innerText.slice(0, 600),
    }));
    fail(`no backup download fired — ${state.url}\n  page said: ${state.text.replace(/\n/g, " | ")}`);
  }
  // Saved outside the dev server's watch tree so the file write can't trigger
  // a page reload mid-flow.
  const backupPath = "node_modules/.ghostwire-qa/qa-backup.gwbak";
  await download.saveAs(backupPath);
  const keyLocator = page.locator("code").filter({ hasText: /^GW1-/ }).first();
  await keyLocator.waitFor({ timeout: 10_000 });
  const backupKey = (await keyLocator.textContent())?.trim() ?? "";
  if (!/^GW1(-[0-9A-F]{4}){8}$/.test(backupKey)) fail(`odd recovery key: "${backupKey}"`);
  const file = JSON.parse(readFileSync(backupPath, "utf8"));
  if (file.kind !== "ghostwire-vault-backup") fail(`unexpected backup file: ${file.kind}`);
  if (!(file.stats?.conversations >= 6)) fail(`backup misses conversations: ${file.stats?.conversations}`);
  note(`backup downloaded (${download.suggestedFilename()}) · key ${backupKey}`);

  await openVaultPanel();
  await backupFileInput().setInputFiles(backupPath);
  await page
    .getByPlaceholder(/Recovery key/)
    .fill("GW1-0000-0000-0000-0000-0000-0000-0000-0000");
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await page.getByText("Wrong recovery key", { exact: false }).waitFor({ timeout: 15_000 });
  note("a wrong recovery key is rejected with a clear error");

  // 4d ── destroy the vault, rebuild it, and restore the backed-up channel
  await page.getByRole("button", { name: "Destroy vault", exact: true }).click();
  await heading("Independent messenger. Connects to wire.com.").waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "Create local vault", exact: true }).click();
  await page.locator('button[aria-label="Contacts"]').first().waitFor({ timeout: 20_000 });
  note("vault destroyed and rebuilt from scratch");

  await openVaultPanel();
  await backupFileInput().setInputFiles(backupPath);
  await page.getByPlaceholder(/Recovery key/).fill(backupKey);
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await page
    .getByText(/Restored 1 conversation/)
    .first()
    .waitFor({ timeout: 20_000 });
  note("recovery key restored the conversation the backup held");
  await shot("07-restored-after-wipe");

  await page.locator('button[aria-label="Contacts"]').first().click();
  await page.locator('button[title="Sign out of this Wire account"]').waitFor({ timeout: 10_000 });
  await page.locator('button[title="Sign out of this Wire account"]').click();
  await heading("Sign in to Wire").waitFor({ timeout: 15_000 });
  if (await session()) fail("session survived sign-out");
  note("signed out with the real sign-out control; session cleared");

  // 5 ── THE FIX TARGET: sign in to the EXISTING account
  await page.getByRole("tab", { name: "This backend", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill(EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await submit().click();
  await landed();
  const resumed = await sessionUser();
  if (resumed?.email !== EMAIL) fail(`signed in as the wrong account: ${resumed?.email}`);
  note("sign-in to an EXISTING account works and shows the right identity");
  await shot("06-existing-signin");

  // 6 ── fresh device state, then the wire.com provider with bad credentials
  await clearSession();
  await heading("Sign in to Wire").waitFor({ timeout: 15_000 });
  await page.getByRole("tab", { name: "wire.com", exact: true }).click();
  await page.getByLabel("wire.com email or @handle", { exact: true }).fill("qa-no-such-user@wire.com");
  await page.getByLabel("Password", { exact: true }).fill("definitely-not-the-password");
  await submit().click();
  await page.locator("section p.text-danger").waitFor({ timeout: 30_000 });
  const wireError = (await page.locator("section p.text-danger").first().textContent()) ?? "";
  if (!/wire\.com/i.test(wireError)) fail(`wire.com provider error is unclear: "${wireError}"`);
  if (await session()) fail("a failed wire.com sign-in must not mint a session");
  await heading("Sign in to wire.com").waitFor({ timeout: 5_000 });
  note(`wire.com provider rejects bad credentials gracefully: "${wireError.trim()}"`);
  await shot("07-wire-com-error");

  // 7 ── "Forgot sign-in details?" → code → new password
  await page.getByRole("tab", { name: "This backend", exact: true }).click();
  await page.getByRole("button", { name: "Forgot sign-in details?", exact: true }).click();
  await heading("Reset your sign-in").waitFor({ timeout: 10_000 });
  await page.getByLabel("Email", { exact: true }).fill(EMAIL);
  await page.getByRole("button", { name: "Send reset code", exact: true }).click();
  await heading("Choose a new password").waitFor({ timeout: 20_000 });
  const resetNotice = page.getByText("In-app inbox", { exact: false });
  await resetNotice.waitFor({ timeout: 10_000 });
  const resetButton = resetNotice.locator("button").first();
  const resetCode = (await resetButton.textContent())?.trim();
  if (!resetCode) fail("no in-app reset code was shown");
  note(`password reset code issued: ${resetCode}`);
  await resetButton.click();
  await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
  await shot("08-recover");
  await page.getByRole("button", { name: "Set new password", exact: true }).click();
  await heading("Sign in to Wire").waitFor({ timeout: 20_000 });
  note("reset confirmed; back at sign-in");

  // 8 ── the NEW password signs in (the old one must no longer matter)
  await page.getByLabel("Email", { exact: true }).fill(EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(NEW_PASSWORD);
  await submit().click();
  await landed();
  const rotated = await sessionUser();
  if (rotated?.email !== EMAIL) fail(`reset sign-in landed on the wrong account: ${rotated?.email}`);
  note("sign-in with the RESET password works");
  await shot("09-signin-reset-password");

  if (problems.length) fail(`browser reported problems:\n  ${problems.join("\n  ")}`);
  note("no console or page errors during the whole flow");
  console.log("\nAUTH QA PASSED");
} catch (err) {
  await shot("99-failure").catch(() => {});
  const state = await page
    .evaluate(() => ({
      url: location.href,
      text: document.body.innerText.slice(0, 900),
    }))
    .catch(() => null);
  console.error(`\nAUTH QA FAILED: ${err.message}`);
  if (state) console.error(`page ${state.url}\nsaid: ${state.text.replace(/\n/g, " | ")}`);
  if (problems.length) console.error(`console/page problems:\n  ${problems.join("\n  ")}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
