import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import { WebSocket } from "ws";
import { createServer, type ServerHandle } from "../../src/server";
import { openDatabase, type Db } from "../../src/db/driver";
import { migrate } from "../../src/db/migrations";
import { JobRepository } from "../../src/store/jobRepository";
import { DeviceRepository } from "../../src/store/deviceRepository";
import { UserRepository } from "../../src/store/userRepository";
import { OrgRepository } from "../../src/store/orgRepository";
import { OrgTokenRepository } from "../../src/store/orgTokenRepository";
import { UserTokenRepository } from "../../src/store/userTokenRepository";
import { signSession } from "../../src/session";
import { fakeStream } from "../helpers/fakeControlStream";

/**
 * Every other control test injects `isDeviceBusy`, which means none of them
 * exercise the thing production actually depends on: that
 * `repo.runningDeviceIds()` already reflects the claimed job at the moment
 * refreshModes() fires. This file wires the REAL repository to the REAL hub
 * through createServer and drives a real scheduler dispatch.
 *
 * The job here is deliberately unrunnable - its in-memory upload context was
 * never registered, so runJob throws immediately. That is the point: a claimed
 * device is busy even when the job cannot proceed, and it must go back to idle
 * when the scheduler finishes failing it.
 */

const SESSION_SECRET = "test-secret-at-least-32-characters-long";
const TOKEN_ENCRYPTION_KEY = "3".repeat(64);
const DEVICE_ID = "emulator-5554";

let dir: string;
let db: Db;
let app: ServerHandle;
let repo: JobRepository;
let server: import("http").Server;
let port: number;
let adminCookie: string;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(10);
  }
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-control-wiring-"));
  db = openDatabase(path.join(dir, "farm.db"));
  migrate(db);

  const deviceRepo = new DeviceRepository(db);
  deviceRepo.seedIfEmpty(DEVICE_ID);
  // Seeded rows are registered but not enrolled; the scheduler only dispatches
  // to enrolled devices.
  deviceRepo.enable(DEVICE_ID);

  const userRepo = new UserRepository(db);
  const orgRepo = new OrgRepository(db);
  const admin = userRepo.create({ username: "admin", email: "ad@example.com", password: "x", isAdmin: true });
  orgRepo.create("wiring-org", [admin.id]);
  adminCookie = `mdf_session=${signSession(admin.id, Date.now() + 60_000, SESSION_SECRET)}`;

  repo = new JobRepository(db);

  app = createServer({
    deviceId: DEVICE_ID,
    dataDir: dir,
    uploadDir: dir,
    sessionSecret: SESSION_SECRET,
    controlFrameIntervalMs: 100,
    captureScreenshot: async () => Buffer.from("fake-png"),
    repo,
    deviceRepo,
    userRepo,
    orgRepo,
    orgTokenRepo: new OrgTokenRepository(db, TOKEN_ENCRYPTION_KEY),
    userTokenRepo: new UserTokenRepository(db, TOKEN_ENCRYPTION_KEY),
    schedulerTickMs: 0,
    runner: async (_file, args) => ({code: 0, stdout: args.includes('get-state') ? 'device' : '', stderr: ''}),
    startControlStream: async () => fakeStream().stream,
  });

  server = app.listen(0) as import("http").Server;
  server.on("upgrade", (req, socket, head) => app.control.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  app.control.close();
  app.scheduler.stop?.();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the banner follows the real job lifecycle, not an injected flag", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/devices/${DEVICE_ID}/control`, {
    headers: { cookie: adminCookie },
  });
  const modes: string[] = [];
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const message = JSON.parse(data.toString());
    if (message.type === "mode") modes.push(message.mode);
  });

  await new Promise<void>((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error("socket never opened")), 3000);
    ws.once("open", () => {
      clearTimeout(guard);
      resolve();
    });
  });
  await waitFor(() => modes.length >= 1, "the first mode message");
  expect(modes[0]).toBe("snapshot-idle");

  // A queued job with no registered upload context: claimable, then instantly
  // failed by runJob. Enough to make the device genuinely busy.
  repo.createJob("wiring-org", ["map/map"]);
  app.scheduler.dispatch?.();

  await waitFor(() => modes.includes("snapshot-job"), "the device to read as busy");
  await waitFor(() => modes.indexOf("snapshot-idle", modes.indexOf("snapshot-job")) !== -1, "the device to read as idle again");

  expect(modes.slice(0, 3)).toEqual(["snapshot-idle", "snapshot-job", "snapshot-idle"]);
  expect(repo.runningDeviceIds()).toEqual([]);

  ws.close();
});

test("a queued job waits for a device under control, then runs once control ends", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/devices/${DEVICE_ID}/control`, { headers: { cookie: adminCookie } });
  const messages: Array<{ type: string; mode?: string }> = [];
  ws.on("message", (data, isBinary) => { if (!isBinary) messages.push(JSON.parse(data.toString())); });
  await new Promise<void>((resolve) => ws.once("open", () => resolve()));
  await waitFor(() => messages.some((m) => m.type === "mode"), "first mode");

  ws.send(JSON.stringify({ type: "take-control" }));
  await waitFor(() => messages.some((m) => m.mode === "live-control"), "live control");

  const job = repo.createJob("wiring-org", ["map/map"]);
  app.scheduler.dispatch?.();
  await delay(100);
  expect(repo.getJob(job.id)?.status).toBe("queued");

  ws.send(JSON.stringify({ type: "release-control" }));
  await waitFor(() => repo.getJob(job.id)?.status !== "queued", "the job to be claimed");

  ws.close();
});
