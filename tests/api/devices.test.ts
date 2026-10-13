import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import express from "express";
import { deviceRoutes, type ScreenshotCapturer } from "../../src/api/devices";
import type { CommandRunner } from "../../src/maestro";
import { openDatabase, type Db } from "../../src/db/driver";
import { migrate } from "../../src/db/migrations";
import { JobRepository } from "../../src/store/jobRepository";
import { DeviceRepository } from "../../src/store/deviceRepository";
import { ControlLeases } from "../../src/control/leases";
import { unknownSetupChecks } from "../../src/deviceSetupChecks";

const DEVICE_ID = "RF8M40H8RFP";

function onlineRunner(model = "Pixel 7"): CommandRunner {
  return async (_file, args) => {
    if (args[0] === "devices") {
      return { code: 0, stdout: `List of devices attached\n${DEVICE_ID}\tdevice\n`, stderr: "" };
    }
    if (args.includes("getprop")) {
      return { code: 0, stdout: `${model}\n`, stderr: "" };
    }
    return { code: 0, stdout: "ok", stderr: "" };
  };
}

function offlineRunner(): CommandRunner {
  return async () => ({ code: 0, stdout: "List of devices attached\n", stderr: "" });
}

let dir: string;
let db: Db;
let repo: JobRepository;
let deviceRepo: DeviceRepository;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-devices-api-"));
  db = openDatabase(path.join(dir, "farm.db"));
  migrate(db);
  repo = new JobRepository(db);
  deviceRepo = new DeviceRepository(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function app(
  opts: {
    runner?: CommandRunner;
    captureScreenshot?: ScreenshotCapturer;
    controlLeases?: ControlLeases;
    hasLiveViewers?: (deviceId: string) => boolean;
  } = {}
): express.Express {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.org = "donable";
    next();
  });
  a.use(
    deviceRoutes({
      repo,
      deviceRepo,
      runner: opts.runner,
      captureScreenshot: opts.captureScreenshot,
      controlLeases: opts.controlLeases,
      hasLiveViewers: opts.hasLiveViewers,
    })
  );
  return a;
}

function maestroVersionRunner(stdout: string, code = 0): CommandRunner {
  return async () => ({ code, stdout, stderr: "" });
}

test("nonblocking version requests return before Maestro and share one cached check", async () => {
  let complete!: (value: { code: number; stdout: string; stderr: string }) => void;
  const runner = jest.fn(() => new Promise<{ code: number; stdout: string; stderr: string }>(resolve => { complete = resolve; }));
  const server = app({ runner });
  const pending = await request(server).get("/api/version?waitForMaestro=false");
  expect(pending.status).toBe(200);
  expect(pending.body.maestroPending).toBe(true);
  expect(typeof pending.body.version).toBe("string");
  await request(server).get("/api/version?waitForMaestro=false");
  expect(runner).toHaveBeenCalledTimes(1);
  complete({ code: 0, stdout: "2.6.1", stderr: "" });
  const ready = await request(server).get("/api/version?waitForMaestro=false");
  expect(ready.body).toMatchObject({ maestroVersion: "2.6.1", maestroPending: false });
  const legacy = await request(server).get("/api/version");
  expect(legacy.body.maestroVersion).toBe("2.6.1");
  expect(legacy.body).not.toHaveProperty("maestroPending");
  expect(runner).toHaveBeenCalledTimes(1);
});

function startRunningJobOn(deviceId: string): string {
  const job = repo.createJob("donable", ["a"]);
  repo.claimNextQueued(deviceId);
  return job.id;
}

function finishedJobOn(deviceId: string): string {
  const job = repo.createJob("donable", ["a"]);
  repo.claimNextQueued(deviceId);
  repo.finishJob(job.id, "done");
  return job.id;
}

test("GET /api/version reports the runner version from BUILD_INFO and the installed Maestro version", async () => {
  const readSpy = jest.spyOn(fs, "readFileSync").mockReturnValue("version=9.9.9\ncommit=abc\n");

  const res = await request(app({ runner: maestroVersionRunner("Maestro CLI v2.6.1\n") })).get("/api/version");

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ version: "9.9.9", maestroVersion: "Maestro CLI v2.6.1" });
  readSpy.mockRestore();
});

test("GET /api/version reports \"unknown\" for the runner version when BUILD_INFO cannot be read", async () => {
  const readSpy = jest.spyOn(fs, "readFileSync").mockImplementation(() => {
    throw new Error("ENOENT");
  });

  const res = await request(app({ runner: maestroVersionRunner("2.6.1") })).get("/api/version");

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ version: "unknown", maestroVersion: "2.6.1" });
  readSpy.mockRestore();
});

test("GET /api/version reports \"unknown\" for maestroVersion when maestro --version fails", async () => {
  const res = await request(app({ runner: maestroVersionRunner("", 1) })).get("/api/version");

  expect(res.status).toBe(200);
  expect(res.body.maestroVersion).toBe("unknown");
});

test("GET /api/devices reports live state, caches the model, and reports version", () => {
  deviceRepo.seedIfEmpty(DEVICE_ID);
  const readSpy = jest.spyOn(fs, "readFileSync").mockReturnValue("version=9.9.9\ncommit=abc\n");

  return request(app({ runner: onlineRunner() }))
    .get("/api/devices")
    .then((res) => {
      expect(res.status).toBe(200);
      expect(res.body.runnerVersion).toBe("9.9.9");
      expect(res.body.artifactBytes).toBe(0);
      expect(res.body.devices).toEqual([
        {
          tags: [],
          id: DEVICE_ID,
          label: DEVICE_ID,
          model: "Pixel 7",
          isActive: true,
          state: "device",
          resetPolicy: "app-only",
          // This fake answers the probe with a bare model and no check
          // markers, so every check is unknown - never a warning.
          setupChecks: unknownSetupChecks(),
        },
      ]);
      expect(deviceRepo.get(DEVICE_ID)?.model).toBe("Pixel 7");
      readSpy.mockRestore();
    });
});

test("GET /api/devices reports a known device as offline, not removed, when disconnected", async () => {
  deviceRepo.seedIfEmpty(DEVICE_ID);
  deviceRepo.updateModel(DEVICE_ID, "Pixel 7");

  const res = await request(app({ runner: offlineRunner() })).get("/api/devices");

  expect(res.status).toBe(200);
  expect(res.body.devices).toHaveLength(1);
  expect(res.body.devices[0]).toMatchObject({ id: DEVICE_ID, state: "offline", model: "Pixel 7" });
});

test("GET /api/devices reports artifactBytes once for the whole farm, not per device", async () => {
  deviceRepo.seedIfEmpty(DEVICE_ID);
  deviceRepo.add("other-device", "Other");

  const res = await request(app({ runner: offlineRunner() })).get("/api/devices");

  expect(res.body.artifactBytes).toBe(0);
  for (const device of res.body.devices) {
    expect(device).not.toHaveProperty("artifactBytes");
  }
});

test("GET /api/devices records a state_change event across two polls, not on the first one", async () => {
  deviceRepo.seedIfEmpty(DEVICE_ID);
  let online = false;
  const flippingRunner: CommandRunner = async (_file, args) => {
    if (args[0] === "devices") {
      return online
        ? { code: 0, stdout: `List of devices attached\n${DEVICE_ID}\tdevice\n`, stderr: "" }
        : { code: 0, stdout: "List of devices attached\n", stderr: "" };
    }
    return { code: 0, stdout: "ok", stderr: "" };
  };
  // One app instance (one deviceRoutes closure) so lastKnownState persists
  // across the two polls below - a fresh app per request would never see a
  // "previous" state to compare against.
  const a = app({ runner: flippingRunner });

  await request(a).get("/api/devices");
  expect(deviceRepo.listEvents(DEVICE_ID)).toHaveLength(0);

  online = true;
  await request(a).get("/api/devices");

  expect(deviceRepo.listEvents(DEVICE_ID)[0]).toMatchObject({ kind: "state_change", detail: "offline -> device" });
});

test("POST /api/devices registers a device and returns setup instructions", async () => {
  const res = await request(app()).post("/api/devices").send({ id: "new-device", label: "Loaner phone" });

  expect(res.status).toBe(201);
  expect(res.body.device).toMatchObject({ id: "new-device", label: "Loaner phone", isActive: false });
  expect(res.body.setupInstructions.length).toBeGreaterThan(0);
  expect(deviceRepo.listEvents("new-device")[0]).toMatchObject({ kind: "added", detail: "registered by donable" });
});

test("POST /api/devices rejects a missing id", async () => {
  const res = await request(app()).post("/api/devices").send({ label: "no id" });
  expect(res.status).toBe(400);
});

test("POST /api/devices rejects a duplicate id", async () => {
  deviceRepo.add("dup-device", "First");
  const res = await request(app()).post("/api/devices").send({ id: "dup-device", label: "Second" });
  expect(res.status).toBe(409);
});

test("POST /api/devices/:id/activate is a deprecated alias for enable - it enrolls without disabling the others", async () => {
  deviceRepo.seedIfEmpty(DEVICE_ID);
  deviceRepo.add("other-device", "Other");

  const res = await request(app()).post("/api/devices/other-device/activate");

  expect(res.status).toBe(200);
  expect(res.body.device.isActive).toBe(true);
  expect(deviceRepo.get(DEVICE_ID)?.isActive).toBe(true);
  expect(deviceRepo.get("other-device")?.isActive).toBe(true);
  expect(deviceRepo.listEvents("other-device")[0].kind).toBe("enabled");
});

test("POST /api/devices/:id/activate (enable) succeeds even while a job is running on another device - enabling a free device disrupts nothing", async () => {
  deviceRepo.seedIfEmpty(DEVICE_ID);
  deviceRepo.add("other-device", "Other");
  startRunningJobOn(DEVICE_ID);

  const res = await request(app()).post("/api/devices/other-device/activate");

  expect(res.status).toBe(200);
  expect(deviceRepo.get("other-device")?.isActive).toBe(true);
});

test("POST /api/devices/:id/activate on an unknown device returns 404", async () => {
  const res = await request(app()).post("/api/devices/unknown/activate");
  expect(res.status).toBe(404);
});

test("enabling a device does not disable the others", async () => {
  await request(app()).post("/api/devices").send({ id: "dev-1" });
  await request(app()).post("/api/devices").send({ id: "dev-2" });

  await request(app()).post("/api/devices/dev-1/enable").expect(200);
  await request(app()).post("/api/devices/dev-2/enable").expect(200);

  const res = await request(app()).get("/api/devices");
  expect(res.body.devices.filter((d: { isActive: boolean }) => d.isActive)).toHaveLength(2);
});

test("disabling a device with a running job succeeds - it drains", async () => {
  await request(app()).post("/api/devices").send({ id: "dev-1" });
  await request(app()).post("/api/devices/dev-1/enable");
  startRunningJobOn("dev-1");

  await request(app()).post("/api/devices/dev-1/disable").expect(200);
});

test("removing a device that is still enabled is refused", async () => {
  await request(app()).post("/api/devices").send({ id: "dev-1" });
  await request(app()).post("/api/devices/dev-1/enable");

  const res = await request(app()).delete("/api/devices/dev-1");
  expect(res.status).toBe(409);
  expect(res.body.error).toMatch(/disable it first/);
});

test("removing a disabled device with a running job is refused", async () => {
  await request(app()).post("/api/devices").send({ id: "dev-1" });
  await request(app()).post("/api/devices/dev-1/enable");
  startRunningJobOn("dev-1");
  await request(app()).post("/api/devices/dev-1/disable");

  const res = await request(app()).delete("/api/devices/dev-1");
  expect(res.status).toBe(409);
  expect(res.body.error).toMatch(/still running/);
});

test("removing a disabled device with an active control lease is refused, and the device still exists", async () => {
  // Finding 2 (final whole-branch review): DELETE checked hasActiveJob but
  // not a live control lease. Removing a phone an admin is driving cascades
  // a device_events FK failure into the hub's onEvent call, which could crash
  // the whole process. This closes that path at the door: DELETE must refuse
  // while a lease is held, before the row can ever be removed.
  await request(app()).post("/api/devices").send({ id: "dev-1" });
  await request(app()).post("/api/devices/dev-1/enable");
  await request(app()).post("/api/devices/dev-1/disable");

  const controlLeases = new ControlLeases();
  controlLeases.acquire("dev-1", { userId: 1, username: "alice" }, 0);

  const res = await request(app({ controlLeases })).delete("/api/devices/dev-1");
  expect(res.status).toBe(409);
  expect(res.body.error).toMatch(/in control/);
  expect(deviceRepo.get("dev-1")).toBeDefined();
});

test("removing a device someone is watching live is refused", async () => {
  await request(app()).post("/api/devices").send({ id: "dev-1" });

  const res = await request(app({ hasLiveViewers: (id) => id === "dev-1" })).delete("/api/devices/dev-1");

  expect(res.status).toBe(409);
  expect(res.body.error).toMatch(/being watched/);
  // Refused means untouched: the device is still registered.
  expect(deviceRepo.get("dev-1")).toBeDefined();
});

test("a live viewer on a DIFFERENT device does not block removal", async () => {
  await request(app()).post("/api/devices").send({ id: "dev-1" });

  await request(app({ hasLiveViewers: (id) => id === "dev-2" })).delete("/api/devices/dev-1").expect(204);

  expect(deviceRepo.get("dev-1")).toBeUndefined();
});

test("removing a disabled idle device succeeds and keeps its jobs' history", async () => {
  await request(app()).post("/api/devices").send({ id: "dev-1" });
  const jobId = finishedJobOn("dev-1");

  await request(app()).delete("/api/devices/dev-1").expect(204);

  expect(repo.getJob(jobId)).toBeDefined();
  expect(repo.getJob(jobId)?.deviceId).toBeNull();
});

test("removing a device logs the removal, since device_events cascades away with the row it would otherwise land on", async () => {
  const outSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  try {
    await request(app()).post("/api/devices").send({ id: "dev-1", label: "Loaner" });

    await request(app()).delete("/api/devices/dev-1").expect(204);

    const line = outSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("device removed"));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line as string);
    expect(parsed).toMatchObject({ msg: "device removed", deviceId: "dev-1", label: "Loaner", actor: "donable" });
  } finally {
    outSpy.mockRestore();
  }
});

test("GET /api/devices/:id/events returns the device's recent events", async () => {
  deviceRepo.add("device-a", "A");
  deviceRepo.recordEvent("device-a", "reboot", "requested by donable");

  const res = await request(app()).get("/api/devices/device-a/events");

  expect(res.status).toBe(200);
  expect(res.body.events).toHaveLength(1);
  expect(res.body.events[0].kind).toBe("reboot");
});

test("POST /api/devices/:id/reboot fires adb reboot and records an event", async () => {
  deviceRepo.seedIfEmpty(DEVICE_ID);
  const rebootRunner: CommandRunner = jest.fn(async () => ({ code: 0, stdout: "", stderr: "" }));

  const res = await request(app({ runner: rebootRunner })).post(`/api/devices/${DEVICE_ID}/reboot`);

  expect(res.status).toBe(202);
  expect(rebootRunner).toHaveBeenCalledWith("adb", ["-s", DEVICE_ID, "reboot"]);
  expect(deviceRepo.listEvents(DEVICE_ID)[0]).toMatchObject({ kind: "reboot", detail: "requested by donable" });
});

test("POST /api/devices/:id/reboot is blocked on a device while a job is running on it", async () => {
  deviceRepo.seedIfEmpty(DEVICE_ID);
  startRunningJobOn(DEVICE_ID);

  const res = await request(app()).post(`/api/devices/${DEVICE_ID}/reboot`);

  expect(res.status).toBe(409);
});

test("POST /api/devices/:id/reboot on another device is not blocked by a running job on the first one", async () => {
  deviceRepo.seedIfEmpty(DEVICE_ID);
  deviceRepo.add("other-device", "Other");
  startRunningJobOn(DEVICE_ID);
  const rebootRunner: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });

  const res = await request(app({ runner: rebootRunner })).post("/api/devices/other-device/reboot");

  expect(res.status).toBe(202);
});

test("rebooting device B is allowed while device A is busy", async () => {
  const rebootRunner: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
  const a = app({ runner: rebootRunner });
  await request(a).post("/api/devices").send({ id: "dev-1" });
  await request(a).post("/api/devices").send({ id: "dev-2" });
  startRunningJobOn("dev-1");

  await request(a).post("/api/devices/dev-2/reboot").expect(202);
  await request(a).post("/api/devices/dev-1/reboot").expect(409);
});

test("POST /api/devices/:id/reboot surfaces an adb failure as 502", async () => {
  deviceRepo.seedIfEmpty(DEVICE_ID);
  const failingRunner: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "device offline" });

  const res = await request(app({ runner: failingRunner })).post(`/api/devices/${DEVICE_ID}/reboot`);

  expect(res.status).toBe(502);
});

test("GET /api/devices/:id/screenshot streams a PNG and records an event", async () => {
  deviceRepo.seedIfEmpty(DEVICE_ID);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const capture: ScreenshotCapturer = jest.fn(async () => png);

  const res = await request(app({ captureScreenshot: capture })).get(`/api/devices/${DEVICE_ID}/screenshot`);

  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toContain("image/png");
  expect(Buffer.compare(res.body, png)).toBe(0);
  expect(deviceRepo.listEvents(DEVICE_ID)[0].kind).toBe("screenshot");
});

test("GET /api/devices/:id/screenshot surfaces a capture failure as 502", async () => {
  deviceRepo.seedIfEmpty(DEVICE_ID);
  const capture: ScreenshotCapturer = async () => {
    throw new Error("device unauthorized");
  };

  const res = await request(app({ captureScreenshot: capture })).get(`/api/devices/${DEVICE_ID}/screenshot`);

  expect(res.status).toBe(502);
});

test("GET /api/devices/:id/screenshot on an unknown device returns 404", async () => {
  const res = await request(app()).get("/api/devices/unknown/screenshot");
  expect(res.status).toBe(404);
});

test("the add-device instructions tell the operator to disable both expiring/blocking settings", async () => {
  const res = await request(app()).post("/api/devices").send({ id: "new-device" });

  expect(res.status).toBe(201);
  const text = res.body.setupInstructions.join("\n");
  expect(text).toMatch(/Disable adb authorization timeout/);
  expect(text).toMatch(/Verify apps over USB/);
});
