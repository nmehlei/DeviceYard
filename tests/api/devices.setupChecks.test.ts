import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import express from "express";
import { deviceRoutes } from "../../src/api/devices";
import type { CommandRunner } from "../../src/maestro";
import { openDatabase, type Db } from "../../src/db/driver";
import { migrate } from "../../src/db/migrations";
import { JobRepository } from "../../src/store/jobRepository";
import { DeviceRepository } from "../../src/store/deviceRepository";

const DEVICE_ID = "RF8M40H8RFP";

let dir: string;
let db: Db;
let repo: JobRepository;
let deviceRepo: DeviceRepository;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-setup-checks-"));
  db = openDatabase(path.join(dir, "farm.db"));
  migrate(db);
  repo = new JobRepository(db);
  deviceRepo = new DeviceRepository(db);
  deviceRepo.add(DEVICE_ID, "S10");
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

type Call = string[];

/** A device in `state`, answering the probe with `probeStdout`, recording every adb call. */
function fakeAdb(opts: {
  state?: string;
  probeStdout?: string;
  probeThrows?: boolean;
  fix?: { code: number; stderr?: string };
  readBack?: string;
}) {
  const calls: Call[] = [];
  const runner: CommandRunner = async (_file, args) => {
    calls.push(args);
    if (args[0] === "devices") {
      const line = opts.state ? `${DEVICE_ID}\t${opts.state}\n` : "";
      return { code: 0, stdout: `List of devices attached\n${line}`, stderr: "" };
    }
    if (args.includes("getprop")) {
      if (opts.probeThrows) throw new Error("adb timed out");
      return { code: 0, stdout: opts.probeStdout ?? "", stderr: "" };
    }
    if (args.includes("put")) {
      return { code: opts.fix?.code ?? 0, stdout: "", stderr: opts.fix?.stderr ?? "" };
    }
    if (args.includes("get")) return { code: 0, stdout: `${opts.readBack ?? "0"}\n`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

function app(runner: CommandRunner, isAdmin = true): express.Express {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.org = "donable";
    req.isAdmin = isAdmin;
    next();
  });
  a.use(deviceRoutes({ repo, deviceRepo, runner }));
  return a;
}

const okById = (body: { devices: { setupChecks: { id: string; ok: boolean | null }[] }[] }) =>
  Object.fromEntries(body.devices[0].setupChecks.map((c) => [c.id, c.ok]));

describe("GET /api/devices setupChecks", () => {
  test("an online device reports each check from the probe", async () => {
    const { runner } = fakeAdb({
      state: "device",
      probeStdout: "SM-G973F\n__DY_CHECK_adb-auth-timeout__\nnull\n__DY_CHECK_adb-install-verification__\n0\n",
    });
    const res = await request(app(runner)).get("/api/devices");

    expect(res.status).toBe(200);
    expect(okById(res.body)).toEqual({ "adb-auth-timeout": false, "adb-install-verification": true });
    expect(res.body.devices[0].setupChecks[0].title).toBe("USB debugging approval expires");
    expect(res.body.devices[0].model).toBe("SM-G973F");
  });

  test("the probe replaces the model getprop - still exactly one shell call per device", async () => {
    const { runner, calls } = fakeAdb({ state: "device", probeStdout: "SM-G973F\n" });
    await request(app(runner)).get("/api/devices");

    const shellCalls = calls.filter((c) => c.includes("shell"));
    expect(shellCalls).toHaveLength(1);
    expect(shellCalls[0]).toEqual(expect.arrayContaining(["verifier_verify_adb_installs", "adb_allowed_connection_time"]));
  });

  test("an unauthorized device is unknown, not a warning, and is not probed", async () => {
    const { runner, calls } = fakeAdb({ state: "unauthorized" });
    const res = await request(app(runner)).get("/api/devices");

    expect(okById(res.body)).toEqual({ "adb-auth-timeout": null, "adb-install-verification": null });
    expect(calls.some((c) => c.includes("shell"))).toBe(false);
  });

  test("a probe that throws leaves the list at 200 with every check unknown", async () => {
    const { runner } = fakeAdb({ state: "device", probeThrows: true });
    const res = await request(app(runner)).get("/api/devices");

    expect(res.status).toBe(200);
    expect(okById(res.body)).toEqual({ "adb-auth-timeout": null, "adb-install-verification": null });
  });
});

describe("POST /api/devices/:id/setup-checks/:checkId/fix", () => {
  const fix = (runner: CommandRunner, opts: { isAdmin?: boolean; device?: string; check?: string } = {}) =>
    request(app(runner, opts.isAdmin ?? true)).post(
      `/api/devices/${opts.device ?? DEVICE_ID}/setup-checks/${opts.check ?? "adb-install-verification"}/fix`
    );
  const setupFixEvents = () => deviceRepo.listEvents(DEVICE_ID).filter((e) => e.kind === "setup_fix");

  test("an admin fix applies exactly the check's write, reads it back, and records who did it", async () => {
    const { runner, calls } = fakeAdb({ state: "device", readBack: "0" });
    const res = await fix(runner);

    expect(res.status).toBe(200);
    expect(res.body.check).toEqual(expect.objectContaining({ id: "adb-install-verification", ok: true }));
    expect(calls).toContainEqual(["-s", DEVICE_ID, "shell", "settings", "put", "global", "verifier_verify_adb_installs", "0"]);
    expect(calls).toContainEqual(["-s", DEVICE_ID, "shell", "settings", "get", "global", "verifier_verify_adb_installs"]);
    const [event] = setupFixEvents();
    expect(event.detail).toBe('"Play Protect verifies adb installs" fixed by donable');
  });

  test("a write that does not stick is a 502 and is not logged as fixed", async () => {
    // Must fail if the read-back step is removed from the route.
    const { runner } = fakeAdb({ state: "device", readBack: "null" });
    const res = await fix(runner);

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("setting did not take effect (read back: null)");
    expect(setupFixEvents()).toHaveLength(0);
  });

  test("a failing write is a 502 carrying adb's error, and nothing is logged", async () => {
    const { runner } = fakeAdb({ state: "device", fix: { code: 255, stderr: "Security exception: permission denied\n" } });
    const res = await fix(runner);

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("could not apply the setting: Security exception: permission denied");
    expect(setupFixEvents()).toHaveLength(0);
  });

  test("non-admins cannot change device settings", async () => {
    const { runner, calls } = fakeAdb({ state: "device" });
    const res = await fix(runner, { isAdmin: false });

    expect(res.status).toBe(403);
    expect(calls.some((c) => c.includes("put"))).toBe(false);
  });

  test("an unknown device is a 404", async () => {
    const { runner } = fakeAdb({ state: "device" });
    const res = await fix(runner, { device: "nope" });

    // The body matters: Express's own 404 for an unmounted route would pass a
    // status-only check.
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("unknown device");
  });

  test("an unknown check is a 404 and runs nothing on the device", async () => {
    const { runner, calls } = fakeAdb({ state: "device" });
    const res = await fix(runner, { check: "package-verifier-enable" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("unknown setup check");
    expect(calls.some((c) => c.includes("shell"))).toBe(false);
  });

  test("a device that is not online and authorized is refused before any write", async () => {
    const { runner, calls } = fakeAdb({ state: "unauthorized" });
    const res = await fix(runner);

    expect(res.status).toBe(409);
    expect(calls.some((c) => c.includes("put"))).toBe(false);
  });

  test("each check fixes only its own setting", async () => {
    const { runner, calls } = fakeAdb({ state: "device", readBack: "0" });
    await fix(runner, { check: "adb-auth-timeout" });

    const writes = calls.filter((c) => c.includes("put"));
    expect(writes).toEqual([["-s", DEVICE_ID, "shell", "settings", "put", "global", "adb_allowed_connection_time", "0"]]);
  });
});
