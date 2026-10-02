import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import {
  SCRCPY_SERVER_SHA256,
  SCRCPY_SERVER_VERSION,
  readVerifiedScrcpyServer,
  scrcpyServerPath,
} from "../../src/control/scrcpyServer";

test("the vendored server matches the pinned checksum", () => {
  const bytes = fs.readFileSync(scrcpyServerPath());
  expect(crypto.createHash("sha256").update(bytes).digest("hex")).toBe(SCRCPY_SERVER_SHA256);
});

test("the vendored file name carries the pinned version", () => {
  expect(path.basename(scrcpyServerPath())).toBe(`scrcpy-server-v${SCRCPY_SERVER_VERSION}`);
});

// CONTROLLER RULING (pre-flight scan): the plan's "options class of the SAME
// version" test read src/control/scrcpy.ts, which does not exist until Task 5.
// It has been MOVED to Task 5 so this task does not complete with a knowingly
// red test. Do not add it here.

test("readVerifiedScrcpyServer refuses a tampered file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-scrcpy-"));
  fs.mkdirSync(path.join(root, "vendor", "scrcpy"), { recursive: true });
  fs.writeFileSync(path.join(root, "vendor", "scrcpy", `scrcpy-server-v${SCRCPY_SERVER_VERSION}`), "not the server");
  await expect(readVerifiedScrcpyServer(root)).rejects.toThrow(/checksum/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("readVerifiedScrcpyServer returns the real bytes", async () => {
  const bytes = await readVerifiedScrcpyServer();
  expect(bytes.length).toBe(90808);
});

test("the adapter drives the server with the options class of the SAME version", () => {
  // The scrcpy server refuses to start when the client's version string
  // differs from its own. The adapter cannot be imported under Jest (ESM), so
  // this reads it as text: bumping the jar without bumping the options class,
  // or the reverse, fails here instead of on a phone.
  const adapter = fs.readFileSync(path.join(__dirname, "../../src/control/scrcpy.ts"), "utf8");
  const expectedClass = `AdbScrcpyOptions${SCRCPY_SERVER_VERSION.replace(/\./g, "_")}`;
  expect(adapter).toContain(expectedClass);
  const allOptionClasses = adapter.match(/AdbScrcpyOptions\d+_\d+(?:_\d+)?/g) ?? [];
  expect(new Set(allOptionClasses)).toEqual(new Set([expectedClass]));
});

test("audio is explicitly disabled (spec D-12: it would be a second encoder)", () => {
  const adapter = fs.readFileSync(path.join(__dirname, "../../src/control/scrcpy.ts"), "utf8");
  expect(adapter).toMatch(/audio:\s*false/);
});
