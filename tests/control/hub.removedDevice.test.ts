import fs from "fs";
import os from "os";
import path from "path";
import { ControlHub, type ControlViewer, type ControlHubDeps } from "../../src/control/hub";
import { ControlLeases } from "../../src/control/leases";
import { openDatabase, type Db } from "../../src/db/driver";
import { migrate } from "../../src/db/migrations";
import { DeviceRepository } from "../../src/store/deviceRepository";

/**
 * Regression for a crash that took the whole service down, and every running
 * CI job with it.
 *
 * The hub records "live view ended" when the last viewer's socket closes. That
 * is an INSERT into device_events, whose device_id references devices(id) with
 * foreign keys enforced. If the device was removed while someone was still
 * watching it, the insert violates the foreign key and throws - inside the ws
 * 'close' event handler, where nothing catches it, so the process exits.
 *
 * The crash fires when the watcher's tab closes, not when the device is
 * removed, which is what made it hard to trace back. These tests use the real
 * repository and a real SQLite database on purpose: a mocked onEvent cannot
 * reproduce a foreign-key violation.
 */

let dir: string;
let db: Db;
let deviceRepo: DeviceRepository;

function fakeViewer() {
  let onClose: (() => void) | undefined;
  const sent: Array<string | Buffer> = [];
  const viewer: ControlViewer = {
    userId: 1,
    username: "watcher",
    send: (d) => sent.push(d),
    close: () => onClose?.(),
    on: (_event, cb) => {
      onClose = cb;
    },
    onMessage: () => {},
  };
  return { viewer, sent, fireClose: () => onClose?.() };
}

function fakeSource() {
  const rec = { started: 0, stopped: 0 };
  return {
    rec,
    createSource: () => ({
      start: () => {
        rec.started++;
      },
      stop: () => {
        rec.stopped++;
      },
    }),
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-hub-removed-"));
  db = openDatabase(path.join(dir, "farm.db"));
  migrate(db);
  deviceRepo = new DeviceRepository(db);
  deviceRepo.add("dev-1", "Test device");
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** These tests exercise the plain watch path only, so the live-control deps are
 * inert stand-ins - no lease is ever acquired and no stream is ever started. */
const idleControlDeps: Pick<ControlHubDeps, "leases" | "startControlStream" | "hasWaitingJobFor" | "onControlReleased"> = {
  leases: new ControlLeases(),
  startControlStream: async () => {
    throw new Error("control is not exercised by these tests");
  },
  hasWaitingJobFor: () => undefined,
  onControlReleased: () => {},
};

function hubRecordingRealEvents(createSource: ReturnType<typeof fakeSource>["createSource"]) {
  return new ControlHub({
    ...idleControlDeps,
    createSource,
    isDeviceBusy: () => false,
    onEvent: (deviceId, detail) => deviceRepo.recordEvent(deviceId, "control", detail),
  });
}

test("a watcher leaving a device that was removed mid-view does not throw", () => {
  const source = fakeSource();
  const hub = hubRecordingRealEvents(source.createSource);
  const watcher = fakeViewer();
  hub.attach("dev-1", watcher.viewer);

  deviceRepo.remove("dev-1");

  // Before the fix this threw a foreign-key violation out of the close handler.
  expect(() => watcher.fireClose()).not.toThrow();
});

test("the hub still tears the device down cleanly when the event cannot be recorded", () => {
  const source = fakeSource();
  const hub = hubRecordingRealEvents(source.createSource);
  const watcher = fakeViewer();
  hub.attach("dev-1", watcher.viewer);
  deviceRepo.remove("dev-1");

  watcher.fireClose();

  // Swallowing the error must not skip the cleanup that follows it: a capture
  // loop left running would keep calling adb against a phone nobody watches.
  expect(source.rec.stopped).toBe(1);
  expect(hub.viewerCount("dev-1")).toBe(0);
});

test("a failing event recorder never breaks attaching a viewer either", () => {
  const source = fakeSource();
  const hub = new ControlHub({
    ...idleControlDeps,
    createSource: source.createSource,
    isDeviceBusy: () => false,
    onEvent: () => {
      throw new Error("database is locked");
    },
  });
  const watcher = fakeViewer();

  expect(() => hub.attach("dev-1", watcher.viewer)).not.toThrow();
  // The viewer still gets its mode message and the loop still starts.
  expect(watcher.sent.some((m) => typeof m === "string" && JSON.parse(m).type === "mode")).toBe(true);
  expect(source.rec.started).toBe(1);
});
