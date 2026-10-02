import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import express from "express";
import { deviceRoutes } from "../../src/api/devices";
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-reset-policy-"));
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

function app(isAdmin: boolean): express.Express {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.org = "donable";
    req.isAdmin = isAdmin;
    next();
  });
  a.use(deviceRoutes({ repo, deviceRepo }));
  return a;
}

const setPolicy = (isAdmin: boolean, body: unknown) =>
  request(app(isAdmin)).post(`/api/devices/${DEVICE_ID}/reset-policy`).send(body as object);

test("a device starts on the weakest policy", () => {
  expect(deviceRepo.get(DEVICE_ID)?.resetPolicy).toBe("app-only");
});

test("an admin can move a device to app-and-browser", async () => {
  const res = await setPolicy(true, { resetPolicy: "app-and-browser" });

  expect(res.status).toBe(200);
  expect(res.body.device.resetPolicy).toBe("app-and-browser");
  expect(deviceRepo.get(DEVICE_ID)?.resetPolicy).toBe("app-and-browser");
});

test("the change is recorded against the device with who made it", async () => {
  await setPolicy(true, { resetPolicy: "app-and-browser" });

  const events = deviceRepo.listEvents(DEVICE_ID);
  const entry = events.find((e) => e.kind === "reset_policy");
  expect(entry).toBeTruthy();
  expect(entry?.detail).toMatch(/app-only/);
  expect(entry?.detail).toMatch(/app-and-browser/);
  expect(entry?.detail).toMatch(/donable/);
});

test("a non-admin cannot change it - this deletes data on the next job", async () => {
  const res = await setPolicy(false, { resetPolicy: "app-and-browser" });

  expect(res.status).toBe(403);
  expect(deviceRepo.get(DEVICE_ID)?.resetPolicy).toBe("app-only");
});

test("an unknown policy is rejected and changes nothing", async () => {
  const res = await setPolicy(true, { resetPolicy: "wipe-everything" });

  expect(res.status).toBe(400);
  expect(deviceRepo.get(DEVICE_ID)?.resetPolicy).toBe("app-only");
});

test("a missing policy is rejected", async () => {
  const res = await setPolicy(true, {});

  expect(res.status).toBe(400);
  expect(deviceRepo.get(DEVICE_ID)?.resetPolicy).toBe("app-only");
});

test("re-setting the same policy is a no-op and logs nothing", async () => {
  const res = await setPolicy(true, { resetPolicy: "app-only" });

  expect(res.status).toBe(200);
  expect(deviceRepo.listEvents(DEVICE_ID).some((e) => e.kind === "reset_policy")).toBe(false);
});

test("an unknown device is a 404", async () => {
  const res = await request(app(true)).post("/api/devices/nope/reset-policy").send({ resetPolicy: "app-only" });

  expect(res.status).toBe(404);
});

test("an unrecognised stored policy reads back as the weakest one", () => {
  // A row written by a newer version, a hand-edited database, or a botched
  // restore must not hand an unknown policy to prepareDevice. Failing safe
  // means failing towards "delete nothing".
  db.run("UPDATE devices SET reset_policy = ? WHERE id = ?", "wipe-everything", DEVICE_ID);

  expect(deviceRepo.get(DEVICE_ID)?.resetPolicy).toBe("app-only");
  expect(deviceRepo.list()[0]?.resetPolicy).toBe("app-only");
});

test("the devices list carries the policy, so the dashboard can show it", async () => {
  await setPolicy(true, { resetPolicy: "app-and-browser" });

  const res = await request(app(true)).get("/api/devices");

  expect(res.status).toBe(200);
  const entry = (res.body.devices as Array<{ id: string; resetPolicy?: string }>).find((d) => d.id === DEVICE_ID);
  expect(entry?.resetPolicy).toBe("app-and-browser");
});
