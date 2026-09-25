/**
 * Vault backups with a recovery key — "säkerhetskopiering & återställ".
 *
 * A backup is a small JSON file (`*.gwbak`) holding everything needed to bring
 * conversations back on a fresh device: the vault's conversations + messages,
 * the device identity and the MLS epoch keys (without those, restored Wire
 * ciphertext can never be decrypted again).
 *
 * The payload is sealed with the app's own PBKDF2 + AES-GCM (`wrapJson`) under
 * a 128-bit recovery key, shown exactly once as `GW1-XXXX-XXXX-…`. The file is
 * useless without the key, and the key is useless without the file — same
 * trade Wire makes for its encrypted backups.
 *
 * Browser-safe: WebCrypto + localStorage only, no server round trip.
 */
import { unwrapJson, wrapJson } from "./crypto";
import { exportEpochs } from "@/lib/wire/mls";
import type { EpochRecord } from "@/lib/wire/mls";
import type { Conversation, Identity, Message } from "./types";

export const BACKUP_KIND = "ghostwire-vault-backup";

/** What the encrypted payload of a backup file contains. */
export interface VaultBackupPayload {
  identity: Identity | null;
  conversations: Conversation[];
  messages: Record<string, Message[]>;
  /** MLS epoch secrets, keyed by conversation id (see `exportEpochs`). */
  epochs: Record<string, EpochRecord>;
}

/** On-disk shape of a `*.gwbak` file — metadata in cleartext, payload sealed. */
export interface BackupFile {
  v: 1;
  kind: typeof BACKUP_KIND;
  app: "app.ghostwire";
  createdAt: string;
  stats: { conversations: number; messages: number };
  /** `wrapJson` blob: AES-GCM ciphertext keyed by the recovery key. */
  payload: string;
}

function countMessages(messages: Record<string, Message[]>): number {
  return Object.values(messages).reduce((n, rows) => n + rows.length, 0);
}

function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** Canonical key material: hex only, uppercased — any spelling normalizes here. */
export function normalizeRecoveryKey(input: string): string {
  const bare = input.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return bare.startsWith("GW1") ? bare.slice(3) : bare;
}

/** Human form: `GW1-XXXX-XXXX-…` (display only — always normalize before use). */
export function formatRecoveryKey(hex: string): string {
  const groups = hex.toUpperCase().match(/.{1,4}/g) ?? [];
  return ["GW1", ...groups].join("-");
}

/**
 * Seal the live vault into a downloadable file and mint the recovery key that
 * opens it. The key is returned once and never stored — write it down before
 * closing the panel.
 */
export async function createVaultBackup(input: {
  identity: Identity | null;
  conversations: Conversation[];
  messages: Record<string, Message[]>;
}): Promise<{ file: BackupFile; recoveryKey: string }> {
  const keyHex = randomHex(16);
  const payload: VaultBackupPayload = {
    identity: input.identity,
    conversations: input.conversations,
    messages: input.messages,
    epochs: exportEpochs(),
  };
  const blob = await wrapJson(keyHex, payload);
  const file: BackupFile = {
    v: 1,
    kind: BACKUP_KIND,
    app: "app.ghostwire",
    createdAt: new Date().toISOString(),
    stats: {
      conversations: input.conversations.length,
      messages: countMessages(input.messages),
    },
    payload: blob,
  };
  return { file, recoveryKey: formatRecoveryKey(keyHex) };
}

/** Parse + shape-check a picked file before asking for the recovery key. */
export async function readBackupFile(text: string): Promise<BackupFile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("That file isn't a GhostWire backup.");
  }
  const file = parsed as BackupFile;
  if (
    !file ||
    file.kind !== BACKUP_KIND ||
    typeof file.payload !== "string" ||
    !file.stats ||
    typeof file.stats.conversations !== "number"
  ) {
    throw new Error("That file isn't a GhostWire backup.");
  }
  return file;
}

/** Decrypt a backup with its recovery key. Throws with a user-facing message. */
export async function restoreVaultBackup(
  file: BackupFile,
  recoveryKey: string,
): Promise<VaultBackupPayload> {
  const key = normalizeRecoveryKey(recoveryKey);
  if (key.length !== 32) {
    throw new Error("Enter the full recovery key (GW1-…-…).");
  }
  let payload: VaultBackupPayload;
  try {
    payload = await unwrapJson<VaultBackupPayload>(key, file.payload);
  } catch {
    throw new Error("Wrong recovery key, or the backup file is damaged.");
  }
  if (!payload || !Array.isArray(payload.conversations) || typeof payload.messages !== "object") {
    throw new Error("That backup file is damaged.");
  }
  return payload;
}

export function backupFilename(file: BackupFile): string {
  const stamp = new Date(file.createdAt).toISOString().slice(0, 10);
  return `ghostwire-backup-${stamp}.gwbak`;
}

/** Hand the file to the browser's download flow (no server involved). */
export function downloadBackup(file: BackupFile): void {
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = backupFilename(file);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}
