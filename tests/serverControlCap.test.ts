import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import { WebSocket } from "ws";
import { createServer } from "../src/server";
import { openDatabase, type Db } from "../src/db/driver";
import { migrate } from "../src/db/migrations";
import { JobRepository } from "../src/store/jobRepository";
import { DeviceRepository } from "../src/store/deviceRepository";
import { UserRepository } from "../src/store/userRepository";
import { OrgRepository } from "../src/store/orgRepository";
import { OrgTokenRepository } from "../src/store/orgTokenRepository";
import { UserTokenRepository } from "../src/store/userTokenRepository";
import { signSession } from "../src/session";
import { fakeStream } from "./helpers/fakeControlStream";

// Finding 1 (final whole-branch review): hasWaitingJobFor ignored
// maxConcurrentJobs, so a saturated farm kept starting - and then
// immediately failing to honor - a countdown on a device an admin is
// controlling, evicting them over and over for a job that can never start
// anyway (Scheduler.dispatch already refuses to claim it at the cap).
//
// This exercises the REAL closure built in src/server.ts, not a hand-rolled
// hasWaitingJobFor stub - every other control test in this repo builds its
// own ControlHub directly, which would never have caught this.

const SESSION_SECRET = "test-secret-at-least-32-characters-long";
const TOKEN_ENCRYPTION_KEY = "3".repeat(64);

let dir: string;
let db: Db;
let repo: JobRepository;
let deviceRepo: DeviceRepository;
let userRepo: UserRepository;
let server: ReturnType<ReturnType<typeof createServer>["listen"]>;
let app: ReturnType<typeof createServer>;
let port: number;
let adminCookie: string;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function once(ws: WebSocket, event: "open" | "message"): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), 4000);
    ws.once(event, (...args) => {
      clearTimeout(guard);
      resolve(args[0]);
    });
  });
}

async function waitForMessage(ws: WebSocket, predicate: (m: any) => boolean, ms = 3000): Promise<any> {
  const deadline = Date.now() + ms;
  const seen: any[] = [];
  return new Promise((resolve, reject) => {
    const onMessage = (data: unknown, isBinary: boolean) => {
      if (isBinary) return;
      const msg = JSON.parse(String(data));
      seen.push(msg);
      if (predicate(msg)) {
        cleanup();
        resolve(msg);
      }
    };
    const timer = setInterval(() => {
      if (Date.now() > deadline) {
        cleanup();
        reject(new Error(`predicate never matched; saw ${JSON.stringify(seen)}`));
      }
    }, 25);
    const cleanup = () => {
      clearInterval(timer);
      ws.off("message", onMessage);
    };
    ws.on("message", onMessage);
  });
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-server-cap-"));
  db = openDatabase(path.join(dir, "farm.db"));
  migrate(db);
  repo = new JobRepository(db);
  deviceRepo = new DeviceRepository(db);
  userRepo = new UserRepository(db);
  const orgRepo = new OrgRepository(db);
  const orgTokenRepo = new OrgTokenRepository(db, TOKEN_ENCRYPTION_KEY);
  const userTokenRepo = new UserTokenRepository(db, TOKEN_ENCRYPTION_KEY);

  deviceRepo.add("dev-1", "dev-1");
  deviceRepo.enable("dev-1");
  deviceRepo.add("dev-2", "dev-2");
  deviceRepo.enable("dev-2");
  deviceRepo.add("dev-3", "dev-3");
  deviceRepo.enable("dev-3");

  const admin = userRepo.create({ username: "admin", email: "admin@example.com", password: "x", isAdmin: true });
  adminCookie = `mdf_session=${signSession(admin.id, Date.now() + 60_000, SESSION_SECRET)}`;

  app = createServer({
    sessionSecret: SESSION_SECRET,
    deviceId: "dev-1",
    deviceRepo,
    userRepo,
    orgRepo,
    orgTokenRepo,
    userTokenRepo,
    repo,
    dataDir: dir,
    schedulerTickMs: 0,
    startControlStream: async () => fakeStream().stream,
  });
  app.scheduler.dispatch = () => {}; // never actually claim/start jobs in this test
  server = app.listen(0);
  server.on("upgrade", (req, socket, head) => app.control.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  app.control.close(); // stops the control tick and releases any leases synchronously
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function connectAndTakeControl(deviceId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/devices/${deviceId}/control`, {
      headers: { cookie: adminCookie },
    });
    ws.once("open", async () => {
      try {
        await waitForMessage(ws, (m) => m.type === "mode"); // initial mode
        ws.send(JSON.stringify({ type: "take-control" }));
        await waitForMessage(ws, (m) => m.type === "mode" && m.mode === "live-control" && m.inControl === true);
        resolve(ws);
      } catch (err) {
        reject(err);
      }
    });
    ws.once("error", reject);
  });
}

test("no countdown starts on a device under control while the farm is at its concurrency cap", async () => {
  repo.setSchedulerSettings({ maxConcurrentJobs: 2 });
  // Two jobs "running" (claimed), occupying the cap.
  repo.createJob("donable", ["a/a"]);
  repo.createJob("donable", ["b/b"]);
  repo.claimNextQueued("dev-1");
  repo.claimNextQueued("dev-2");
  // A third job queued, with nowhere to go even once dev-3 frees up, because
  // the farm is already at cap.
  repo.createJob("donable", ["c/c"]);

  const ws = await connectAndTakeControl("dev-3");
  const messages: any[] = [];
  ws.on("message", (data, isBinary) => { if (!isBinary) messages.push(JSON.parse(String(data))); });
  try {
    // Real 1s tick in server.ts; give it several passes to prove this isn't a
    // timing fluke.
    await delay(3400);
    expect(messages.some((m) => m.type === "release-pending")).toBe(false);
  } finally {
    ws.close();
    await delay(150); // let the server-side close handler run before the db closes
  }
}, 15000);

test("sanity: below the cap, the same waiting job DOES start a countdown", async () => {
  // Same shape as the previous test - two devices busy, dev-3 under control,
  // a third job queued with nowhere else to go - except the cap is 3, so
  // runningCount (2) is still under it. This isolates the cap check: without
  // it (the pre-fix code) this passed too, which is why the "at cap" test
  // above is the one that actually proves the fix.
  repo.setSchedulerSettings({ maxConcurrentJobs: 3 });
  repo.createJob("donable", ["a/a"]);
  repo.createJob("donable", ["b/b"]);
  repo.claimNextQueued("dev-1");
  repo.claimNextQueued("dev-2");
  repo.createJob("donable", ["c/c"]); // queued, waiting

  const ws = await connectAndTakeControl("dev-3");
  try {
    const pending = await waitForMessage(ws, (m) => m.type === "release-pending", 4000);
    expect(pending.reason).toBe("a job is waiting for this device");
  } finally {
    ws.close();
    await delay(150); // let the server-side close handler run before the db closes
  }
}, 15000);
