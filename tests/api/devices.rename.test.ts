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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-rename-"));
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

function app(): express.Express {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.org = "donable";
    next();
  });
  a.use(deviceRoutes({ repo, deviceRepo }));
  return a;
}

const rename = (body: unknown) =>
  request(app()).patch(`/api/devices/${DEVICE_ID}`).send(body as object);

test("renames the device", async () => {
  const res = await rename({ label: "Galaxy S10 (farm)" });

  expect(res.status).toBe(200);
  expect(res.body.device.label).toBe("Galaxy S10 (farm)");
  expect(deviceRepo.get(DEVICE_ID)?.label).toBe("Galaxy S10 (farm)");
});

test("the rename is recorded with both names and who did it", async () => {
  await rename({ label: "Galaxy S10 (farm)" });

  const entry = deviceRepo.listEvents(DEVICE_ID).find((e) => e.kind === "renamed");
  expect(entry?.detail).toMatch(/S10/);
  expect(entry?.detail).toMatch(/Galaxy S10 \(farm\)/);
  expect(entry?.detail).toMatch(/donable/);
});

test("surrounding whitespace is trimmed", async () => {
  const res = await rename({ label: "  Desk phone  " });

  expect(res.body.device.label).toBe("Desk phone");
});

test("an empty name is rejected rather than falling back to the serial", async () => {
  // Enrolment defaults to the id when no label is given; clearing the field on
  // an edit is a mistake, not a request to be called RF8M40H8RFP.
  for (const label of ["", "   "]) {
    const res = await rename({ label });
    expect(res.status).toBe(400);
  }
  expect(deviceRepo.get(DEVICE_ID)?.label).toBe("S10");
});

test("a non-string name is rejected", async () => {
  const res = await rename({ label: 42 });

  expect(res.status).toBe(400);
  expect(deviceRepo.get(DEVICE_ID)?.label).toBe("S10");
});

test("an over-long name is rejected", async () => {
  const res = await rename({ label: "x".repeat(101) });

  expect(res.status).toBe(400);
  expect(deviceRepo.get(DEVICE_ID)?.label).toBe("S10");
});

test("a name of exactly the limit is accepted", async () => {
  const res = await rename({ label: "x".repeat(100) });

  expect(res.status).toBe(200);
});

test("renaming to the same name logs nothing", async () => {
  const res = await rename({ label: "S10" });

  expect(res.status).toBe(200);
  expect(deviceRepo.listEvents(DEVICE_ID).some((e) => e.kind === "renamed")).toBe(false);
});

test("an unknown device is a 404", async () => {
  const res = await request(app()).patch("/api/devices/nope").send({ label: "x" });

  expect(res.status).toBe(404);
});
