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
import { UserRepository } from "../../src/store/userRepository";

const DEVICE_ID = "RF8M40H8RFP";

let dir: string;
let db: Db;
let repo: JobRepository;
let deviceRepo: DeviceRepository;
let userRepo: UserRepository;
let userId: number;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-actor-"));
  db = openDatabase(path.join(dir, "farm.db"));
  migrate(db);
  repo = new JobRepository(db);
  deviceRepo = new DeviceRepository(db);
  userRepo = new UserRepository(db);
  userId = userRepo.create({
    username: "nicolas",
    email: "n@example.com",
    password: "a-long-enough-password",
    isAdmin: true,
  }).id;
  deviceRepo.add(DEVICE_ID, "S10");
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function app(who: { userId?: number; org?: string }, withUserRepo = true): express.Express {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    if (who.userId !== undefined) req.userId = who.userId;
    if (who.org !== undefined) req.org = who.org;
    req.isAdmin = true;
    next();
  });
  a.use(deviceRoutes({ repo, deviceRepo, ...(withUserRepo ? { userRepo } : {}) }));
  return a;
}

const detailOf = (kind: string) => deviceRepo.listEvents(DEVICE_ID).find((e) => e.kind === kind)?.detail ?? "";

test("a session action is credited to the username, not 'undefined'", async () => {
  // Regression: the dashboard sends no x-org-id, so req.org is unset and the
  // log read "by undefined" in production.
  await request(app({ userId }))
    .post(`/api/devices/${DEVICE_ID}/reset-policy`)
    .send({ resetPolicy: "app-and-browser" });

  expect(detailOf("reset_policy")).toContain("nicolas");
  expect(detailOf("reset_policy")).not.toContain("undefined");
});

test("a rename is credited the same way", async () => {
  await request(app({ userId })).patch(`/api/devices/${DEVICE_ID}`).send({ label: "Desk phone" });

  expect(detailOf("renamed")).toContain("nicolas");
  expect(detailOf("renamed")).not.toContain("undefined");
});

test("a token caller with an org but no user is credited to the org", async () => {
  // The device is enrolled inactive, so enable is the transition that happens.
  await request(app({ org: "donable" })).post(`/api/devices/${DEVICE_ID}/enable`).send();

  expect(detailOf("enabled")).toContain("donable");
  expect(detailOf("enabled")).not.toContain("undefined");
});

test("an unresolvable user still never logs 'undefined'", async () => {
  // userRepo absent, and no org: the worst case must stay an identifier.
  await request(app({ userId }, false)).patch(`/api/devices/${DEVICE_ID}`).send({ label: "Desk phone" });

  const detail = detailOf("renamed");
  expect(detail).not.toContain("undefined");
  // The whole token, not a bare digit: the device label "S10" contains a "1",
  // so `toContain(String(userId))` matched that instead and could never fail.
  expect(detail).toContain(`user #${userId}`);
});

test("no identity at all is named explicitly rather than left blank", async () => {
  await request(app({}, false)).patch(`/api/devices/${DEVICE_ID}`).send({ label: "Desk phone" });

  expect(detailOf("renamed")).not.toContain("undefined");
  expect(detailOf("renamed")).toMatch(/unidentified/);
});
