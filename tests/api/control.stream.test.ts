import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import type { AddressInfo } from "net";
import { WebSocket } from "ws";
import { createControlUpgrade } from "../../src/api/control";
import { ControlHub } from "../../src/control/hub";
import { ControlLeases } from "../../src/control/leases";
import { createFrameSource } from "../../src/control/frames";
import { openDatabase, type Db } from "../../src/db/driver";
import { migrate } from "../../src/db/migrations";
import { UserRepository } from "../../src/store/userRepository";
import { DeviceRepository } from "../../src/store/deviceRepository";
import { signSession } from "../../src/session";

const SESSION_SECRET = "test-secret-at-least-32-characters-long";
const INTERVAL_MS = 10;

let dir: string;
let db: Db;
let userRepo: UserRepository;
let deviceRepo: DeviceRepository;
let server: http.Server;
let control: ReturnType<typeof createControlUpgrade>;
let hub: ControlHub;
let port: number;
let adminCookie: string;

let captureCalls = 0;
let captureImpl: (deviceId: string) => Promise<Buffer>;
let busy = false;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every wait has a bound, so a broken implementation fails instead of
 * hanging the suite. */
function once(ws: WebSocket, event: "open" | "close"): Promise<void> {
  if (event === "close" && ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const guard = setTimeout(
      () => reject(new Error(`timed out waiting for "${event}" (readyState=${ws.readyState})`)),
      2000
    );
    ws.once(event, () => {
      clearTimeout(guard);
      resolve();
    });
  });
}

async function waitFor(predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await delay(5);
  }
}

function openSocket(): { ws: WebSocket; texts: string[]; frames: Buffer[] } {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/devices/dev-1/control`, {
    headers: { cookie: adminCookie },
  });
  const texts: string[] = [];
  const frames: Buffer[] = [];
  ws.on("message", (data, isBinary) => {
    if (isBinary) frames.push(data as Buffer);
    else texts.push(data.toString());
  });
  return { ws, texts, frames };
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-control-stream-"));
  db = openDatabase(path.join(dir, "farm.db"));
  migrate(db);
  userRepo = new UserRepository(db);
  deviceRepo = new DeviceRepository(db);

  const admin = userRepo.create({ username: "admin", email: "ad@example.com", password: "x", isAdmin: true });
  adminCookie = `mdf_session=${signSession(admin.id, Date.now() + 60_000, SESSION_SECRET)}`;
  deviceRepo.add("dev-1", "Test device");

  captureCalls = 0;
  busy = false;
  captureImpl = async () => Buffer.from("fake-png");

  hub = new ControlHub({
    isDeviceBusy: () => busy,
    onEvent: (deviceId, detail) => deviceRepo.recordEvent(deviceId, "control", detail),
    createSource: (deviceId, onFrame, onError) =>
      createFrameSource({
        deviceId,
        intervalMs: INTERVAL_MS,
        capture: async (id) => {
          captureCalls++;
          return captureImpl(id);
        },
        onFrame,
        onError,
      }),
    leases: new ControlLeases(),
    startControlStream: async () => { throw new Error("not used in this test"); },
    hasWaitingJobFor: () => undefined,
    onControlReleased: () => {},
  });

  control = createControlUpgrade({ userRepo, deviceRepo, sessionSecret: SESSION_SECRET, hub });
  server = http.createServer((_req, res) => res.end());
  server.on("upgrade", (req, socket, head) => control.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  hub.close();
  control.close();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sends the mode first, then streams frames", async () => {
  const { ws, texts, frames } = openSocket();
  await once(ws, "open");
  await waitFor(() => frames.length >= 2);

  expect(JSON.parse(texts[0])).toEqual({
    type: "mode",
    mode: "snapshot-idle",
    label: "Snapshot view",
    reason: "idle",
  });
  expect(frames[0][0]).toBe(1);
  expect(frames[0].subarray(1).toString()).toBe("fake-png");
  ws.close();
  await once(ws, "close");
});

test("streams to a device that is running a job, labelled as such", async () => {
  // The whole point of D-3: watching a running job must work, and must go
  // through screencap so it cannot disturb the job's own recording.
  busy = true;
  const { ws, texts, frames } = openSocket();
  await once(ws, "open");
  await waitFor(() => frames.length >= 1);

  expect(JSON.parse(texts[0])).toMatchObject({ mode: "snapshot-job", reason: "a job is running" });
  ws.close();
  await once(ws, "close");
});

test("stops capturing when the last viewer disconnects", async () => {
  const { ws, frames } = openSocket();
  await once(ws, "open");
  await waitFor(() => frames.length >= 2);

  ws.close();
  await once(ws, "close");
  const atClose = captureCalls;

  await delay(INTERVAL_MS * 8);
  // At most one more: a capture already in flight when the socket closed is
  // allowed to finish, it just must not be delivered or rescheduled.
  expect(captureCalls).toBeLessThanOrEqual(atClose + 1);
});

test("two viewers of one device share a single capture loop", async () => {
  const a = openSocket();
  const b = openSocket();
  await once(a.ws, "open");
  await once(b.ws, "open");
  await waitFor(() => a.frames.length >= 3 && b.frames.length >= 3);

  // Both saw at least three frames; if each viewer had its own loop, the
  // capture count would be at least double the frames any one viewer saw.
  const maxSeen = Math.max(a.frames.length, b.frames.length);
  expect(captureCalls).toBeLessThan(maxSeen * 2);

  const closed = Promise.all([once(a.ws, "close"), once(b.ws, "close")]);
  a.ws.close();
  b.ws.close();
  await closed;
});

test("reports a capture failure to the viewer instead of closing the socket", async () => {
  captureImpl = async () => {
    throw new Error("device offline");
  };
  const { ws, texts } = openSocket();
  await once(ws, "open");
  await waitFor(() => texts.some((t) => JSON.parse(t).type === "error"));

  const error = texts.map((t) => JSON.parse(t)).find((m) => m.type === "error");
  expect(error.message).toContain("device offline");
  expect(ws.readyState).toBe(WebSocket.OPEN);
  ws.close();
  await once(ws, "close");
});

test("records live view start and end on the device event log", async () => {
  const { ws, frames } = openSocket();
  await once(ws, "open");
  await waitFor(() => frames.length >= 1);
  ws.close();
  await once(ws, "close");
  await waitFor(() => deviceRepo.listEvents("dev-1").some((e) => e.detail === "live view ended"));

  const details = deviceRepo.listEvents("dev-1").map((e) => e.detail);
  expect(details).toContain("live view started");
  expect(details).toContain("live view ended");
});
