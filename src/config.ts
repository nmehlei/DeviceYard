import os from "os";
import { loadNotificationConfig, type NotificationConfig } from "./notifications/config";

export interface Config {
  tokensByOrg: Record<string, string>;
  deviceId: string;
  port: number;
  uploadDir: string;
  dataDir: string;
  sessionSecret: string;
  adminUsername: string;
  adminPassword: string;
  adminEmail: string;
  tokenEncryptionKey: string;
  /** Floor between screen captures for an admin's live view. NOT a frame
   * rate: `screencap` itself takes 0.8-2.8s depending on device load, so the
   * device, not this number, is what bounds the effective rate. */
  controlFrameIntervalMs: number;
  notification: NotificationConfig;
}

/** Job history and artifacts live here. Deliberately outside the deploy
 * bundle: the update timer replaces that directory wholesale on every merge
 * to main, and taking the database with it is exactly the data loss this
 * work exists to end. */
export const DEFAULT_DATA_DIR = "/opt/mobile-device-farm/data";

function required(env: NodeJS.ProcessEnv, name: string, example: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} env var is required, e.g. ${example}`);
  }
  return value;
}

function parseTokens(raw: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // A malformed vaulted value used to surface as a raw SyntaxError stack
    // with no hint about which env var was at fault.
    throw new Error(`TOKENS_JSON is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error('TOKENS_JSON must be a JSON object mapping org name to token, e.g. {"donable":"..."}');
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.some(([, token]) => typeof token !== "string")) {
    throw new Error('TOKENS_JSON must be a JSON object mapping org name to token, e.g. {"donable":"..."}');
  }

  return Object.fromEntries(entries) as Record<string, string>;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const tokensByOrg = parseTokens(required(env, "TOKENS_JSON", '{"donable":"..."}'));
  const deviceId = required(env, "DEVICE_ID", "emulator-5554 (adb serial of the target device)");
  const sessionSecret = required(env, "SESSION_SECRET", "a long random string from the vault");
  // A short secret makes offline forgery of session cookies (brute-forcing an
  // HMAC key) practical; this is the only place the code can push back on
  // that before it starts serving requests. The message states the required
  // minimum and the actual length, never the value itself.
  if (sessionSecret.length < 32) {
    throw new Error(`SESSION_SECRET must be at least 32 characters, got ${sessionSecret.length}`);
  }

  const adminUsername = required(env, "ADMIN_USERNAME", "admin");
  const adminPassword = required(env, "ADMIN_PASSWORD", "a long random string from the vault");
  const adminEmail = required(env, "ADMIN_EMAIL", "admin@example.com");

  const tokenEncryptionKey = required(
    env,
    "TOKEN_ENCRYPTION_KEY",
    "64 hex characters (32 bytes) - generate with: openssl rand -hex 32"
  );
  // Never include the value itself in the error - same discipline as the
  // SESSION_SECRET length check just above.
  if (!/^[0-9a-fA-F]{64}$/.test(tokenEncryptionKey)) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)");
  }

  const rawPort = env.PORT ?? "8080";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`PORT must be a positive integer, got "${rawPort}"`);
  }

  // A floor low enough to be pointless (the device cannot answer that fast)
  // only wastes adb spawns on a phone that may be running CI, so refuse it
  // rather than quietly accept a number that cannot do what it says.
  const rawInterval = env.CONTROL_FRAME_INTERVAL_MS ?? "1000";
  const controlFrameIntervalMs = Number(rawInterval);
  if (!Number.isInteger(controlFrameIntervalMs) || controlFrameIntervalMs < 100) {
    throw new Error(
      `CONTROL_FRAME_INTERVAL_MS must be an integer of at least 100 (milliseconds), got "${rawInterval}"`
    );
  }

  return {
    tokensByOrg,
    deviceId,
    controlFrameIntervalMs,
    sessionSecret,
    adminUsername,
    adminPassword,
    adminEmail,
    tokenEncryptionKey,
    notification: loadNotificationConfig(env),
    port,
    uploadDir: env.UPLOAD_DIR ?? os.tmpdir(),
    dataDir: env.DATA_DIR ?? DEFAULT_DATA_DIR,
  };
}
