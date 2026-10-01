import os from "os";
import { loadConfig } from "../src/config";

const base = {
  TOKENS_JSON: '{"donable":"t"}',
  DEVICE_ID: "emulator-5554",
  SESSION_SECRET: "a-session-secret-at-least-32-chars-long",
  ADMIN_USERNAME: "admin",
  ADMIN_PASSWORD: "a-bootstrap-password",
  ADMIN_EMAIL: "admin@example.com",
  TOKEN_ENCRYPTION_KEY: "0".repeat(64),
};

test("reads a full valid environment", () => {
  const cfg = loadConfig({ ...base, PORT: "9090", DATA_DIR: "/data" } as NodeJS.ProcessEnv);

  expect(cfg.tokensByOrg).toEqual({ donable: "t" });
  expect(cfg.deviceId).toBe("emulator-5554");
  expect(cfg.port).toBe(9090);
  expect(cfg.dataDir).toBe("/data");
});

test("applies documented defaults", () => {
  const cfg = loadConfig(base as NodeJS.ProcessEnv);

  expect(cfg.port).toBe(8080);
  expect(cfg.dataDir).toBe("/opt/mobile-device-farm/data");
  expect(cfg.uploadDir).toBe(os.tmpdir());
});

test("malformed TOKENS_JSON explains itself instead of throwing a raw SyntaxError", () => {
  expect(() => loadConfig({ ...base, TOKENS_JSON: "{not json" } as NodeJS.ProcessEnv)).toThrow(
    /TOKENS_JSON is not valid JSON/
  );
});

test("TOKENS_JSON that is not an object of strings is rejected", () => {
  expect(() => loadConfig({ ...base, TOKENS_JSON: '["a"]' } as NodeJS.ProcessEnv)).toThrow(
    /TOKENS_JSON must be a JSON object mapping org name to token/
  );
  expect(() => loadConfig({ ...base, TOKENS_JSON: '{"a":1}' } as NodeJS.ProcessEnv)).toThrow(
    /TOKENS_JSON must be a JSON object mapping org name to token/
  );
});

test("missing required vars name themselves", () => {
  expect(() => loadConfig({ ...base, TOKENS_JSON: undefined } as NodeJS.ProcessEnv)).toThrow(/TOKENS_JSON/);
  expect(() => loadConfig({ ...base, DEVICE_ID: undefined } as NodeJS.ProcessEnv)).toThrow(/DEVICE_ID/);
  expect(() => loadConfig({ ...base, SESSION_SECRET: undefined } as NodeJS.ProcessEnv)).toThrow(/SESSION_SECRET/);
  expect(() => loadConfig({ ...base, ADMIN_USERNAME: undefined } as NodeJS.ProcessEnv)).toThrow(/ADMIN_USERNAME/);
  expect(() => loadConfig({ ...base, ADMIN_PASSWORD: undefined } as NodeJS.ProcessEnv)).toThrow(/ADMIN_PASSWORD/);
  expect(() => loadConfig({ ...base, ADMIN_EMAIL: undefined } as NodeJS.ProcessEnv)).toThrow(/ADMIN_EMAIL/);
  expect(() => loadConfig({ ...base, TOKEN_ENCRYPTION_KEY: undefined } as NodeJS.ProcessEnv)).toThrow(
    /TOKEN_ENCRYPTION_KEY/
  );
});

test("a non-numeric PORT is rejected rather than silently becoming NaN", () => {
  expect(() => loadConfig({ ...base, PORT: "eighty" } as NodeJS.ProcessEnv)).toThrow(/PORT/);
});

test("a SESSION_SECRET shorter than 32 characters is rejected, without leaking its value", () => {
  const shortSecret = "too-short";
  let thrown: unknown;
  try {
    loadConfig({ ...base, SESSION_SECRET: shortSecret } as NodeJS.ProcessEnv);
  } catch (err) {
    thrown = err;
  }

  expect(thrown).toBeInstanceOf(Error);
  const message = (thrown as Error).message;
  expect(message).toMatch(/SESSION_SECRET/);
  expect(message).toMatch(/32/);
  expect(message).not.toContain(shortSecret);
});

test("reads the admin bootstrap and token encryption env vars", () => {
  const cfg = loadConfig(base as NodeJS.ProcessEnv);
  expect(cfg.adminUsername).toBe("admin");
  expect(cfg.adminPassword).toBe("a-bootstrap-password");
  expect(cfg.adminEmail).toBe("admin@example.com");
  expect(cfg.tokenEncryptionKey).toBe("0".repeat(64));
});

test("a TOKEN_ENCRYPTION_KEY that isn't exactly 64 hex characters is rejected, without leaking its value", () => {
  let thrown: unknown;
  try {
    loadConfig({ ...base, TOKEN_ENCRYPTION_KEY: "too-short" } as NodeJS.ProcessEnv);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toMatch(/TOKEN_ENCRYPTION_KEY must be exactly 64 hex characters/);
  expect((thrown as Error).message).not.toContain("too-short");
});

test("a TOKEN_ENCRYPTION_KEY with non-hex characters is rejected", () => {
  expect(() => loadConfig({ ...base, TOKEN_ENCRYPTION_KEY: "g".repeat(64) } as NodeJS.ProcessEnv)).toThrow(
    /TOKEN_ENCRYPTION_KEY must be exactly 64 hex characters/
  );
});

test("CONTROL_FRAME_INTERVAL_MS defaults to one second", () => {
  expect(loadConfig(base as NodeJS.ProcessEnv).controlFrameIntervalMs).toBe(1000);
});

test("CONTROL_FRAME_INTERVAL_MS accepts an explicit value", () => {
  const cfg = loadConfig({ ...base, CONTROL_FRAME_INTERVAL_MS: "2500" } as NodeJS.ProcessEnv);
  expect(cfg.controlFrameIntervalMs).toBe(2500);
});

test.each(["0", "50", "abc", "1.5", ""])(
  "CONTROL_FRAME_INTERVAL_MS rejects %p by naming the variable",
  (value) => {
    // A floor below what the device can answer only wastes adb spawns on a
    // phone that may be running CI, so it is refused rather than accepted.
    // An empty value fails too, exactly as PORT does: the service refuses to
    // start on a malformed value rather than guessing what was meant.
    const env = { ...base, CONTROL_FRAME_INTERVAL_MS: value } as NodeJS.ProcessEnv;
    expect(() => loadConfig(env)).toThrow(/CONTROL_FRAME_INTERVAL_MS must be an integer of at least 100/);
  }
);
