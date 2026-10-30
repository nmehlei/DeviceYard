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

const ID = "RF8M40H8RFP";
let dir: string;
let db: Db;
let deviceRepo: DeviceRepository;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-isolation-"));
  db = openDatabase(path.join(dir, "farm.db"));
  migrate(db);
  deviceRepo = new DeviceRepository(db);
  deviceRepo.add(ID, "S10");
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const runner: CommandRunner = async (_f, args) => {
  if (args[0] === "devices") return { code: 0, stdout: `List of devices attached\n${ID}\tdevice\n`, stderr: "" };
  const rest = args.slice(2).join(" ");
  if (rest === "shell pm list features") return { code: 0, stdout: "feature:android.software.managed_users\n", stderr: "" };
  if (rest === "shell pm list users") return { code: 0, stdout: "Users:\n\tUserInfo{0:Owner:c13} running\n", stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
};

function app(isolationEnabled?: boolean, r: CommandRunner = runner, maintenance?: unknown) {
  const a = express();
  a.use(express.json());
  a.use(deviceRoutes({ repo: new JobRepository(db), deviceRepo, runner: r, isolationEnabled, ...(maintenance ? { maintenance: maintenance as never } : {}) }));
  return a;
}

test("the device list shows isolationCapable only when the edition provides isolation", async () => {
  const off = await request(app(false)).get("/api/devices");
  expect(off.body.devices[0]).not.toHaveProperty("isolationCapable");
  expect(deviceRepo.get(ID)!.isolationCapable).toBeNull();

  const on = await request(app(true)).get("/api/devices");
  expect(on.body.devices[0].isolationCapable).toBe(true);
  expect(deviceRepo.get(ID)!.isolationCapable).toBe(true);
});

test("a probe that returns unknown keeps the stored capability", async () => {
  deviceRepo.setIsolationCapable(ID, true);
  const failing: CommandRunner = async (f, args) => {
    if (args.join(" ").includes("pm list")) throw new Error("timed out");
    return runner(f, args);
  };
  const res = await request(app(true, failing)).get("/api/devices");
  expect(res.body.devices[0].isolationCapable).toBe(true);
  expect(deviceRepo.get(ID)!.isolationCapable).toBe(true);
});

test("the maintenance-mode device list hides isolationCapable unless isolation is enabled", async () => {
  deviceRepo.setIsolationCapable(ID, true);
  const busy = { acquire: () => undefined, snapshot: () => ({ state: "draining" }) };
  const off = await request(app(false, runner, busy)).get("/api/devices");
  expect(off.body.stale).toBe(true);
  expect(off.body.devices[0]).not.toHaveProperty("isolationCapable");
  const on = await request(app(true, runner, busy)).get("/api/devices");
  expect(on.body.devices[0].isolationCapable).toBe(true);
});

test("device mutation responses hide isolationCapable unless isolation is enabled", async () => {
  deviceRepo.setIsolationCapable(ID, true);
  const off = await request(app(false)).patch(`/api/devices/${ID}`).send({ label: "Renamed" });
  expect(off.status).toBe(200);
  expect(off.body.device.label).toBe("Renamed");
  expect(off.body.device).not.toHaveProperty("isolationCapable");
  const on = await request(app(true)).patch(`/api/devices/${ID}`).send({ label: "Renamed again" });
  expect(on.body.device.isolationCapable).toBe(true);
});
