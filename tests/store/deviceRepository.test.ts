import fs from "fs";
import os from "os";
import path from "path";
import { openDatabase, type Db } from "../../src/db/driver";
import { migrate } from "../../src/db/migrations";
import { DeviceRepository } from "../../src/store/deviceRepository";

let dir: string;
let db: Db;
let repo: DeviceRepository;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-device-repo-"));
  db = openDatabase(path.join(dir, "farm.db"));
  migrate(db);
  repo = new DeviceRepository(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("seedIfEmpty inserts one active device when the table is empty", () => {
  repo.seedIfEmpty("RF8M40H8RFP");

  const devices = repo.list();
  expect(devices).toHaveLength(1);
  expect(devices[0]).toMatchObject({ id: "RF8M40H8RFP", label: "RF8M40H8RFP", isActive: true, model: null });
});

test("seedIfEmpty is a no-op once the table has any row - never re-creates or overrides an existing device", () => {
  repo.add("existing-device", "My phone");
  repo.seedIfEmpty("RF8M40H8RFP");

  const devices = repo.list();
  expect(devices).toHaveLength(1);
  expect(devices[0].id).toBe("existing-device");
});

test("add registers a new, inactive device", () => {
  const device = repo.add("RF8M40H8RFP", "Pixel 7");
  expect(device).toMatchObject({ id: "RF8M40H8RFP", label: "Pixel 7", isActive: false, model: null });
  expect(repo.get("RF8M40H8RFP")).toEqual(device);
});

test("enable adds a device to the pool without disabling others", () => {
  repo.add("device-a", "A");
  repo.add("device-b", "B");
  repo.enable("device-a");

  expect(repo.get("device-a")?.isActive).toBe(true);
  expect(repo.get("device-b")?.isActive).toBe(false);
  expect(repo.listEnrolled().map((d) => d.id)).toEqual(["device-a"]);

  repo.enable("device-b");

  expect(repo.get("device-a")?.isActive).toBe(true);
  expect(repo.get("device-b")?.isActive).toBe(true);
  // Both enrolled, oldest enrolment first - the pool, not "the" active one.
  expect(repo.listEnrolled().map((d) => d.id)).toEqual(["device-a", "device-b"]);
});

test("updateModel caches the last-seen model, surviving disconnection", () => {
  repo.add("device-a", "A");
  repo.updateModel("device-a", "Pixel 7 Pro");
  expect(repo.get("device-a")?.model).toBe("Pixel 7 Pro");
});

test("recordEvent + listEvents returns newest first", () => {
  repo.add("device-a", "A");
  repo.recordEvent("device-a", "added", "registered by donable");
  repo.recordEvent("device-a", "activated", "activated by donable");

  const events = repo.listEvents("device-a");
  expect(events.map((e) => e.kind)).toEqual(["activated", "added"]);
  expect(events[0].detail).toBe("activated by donable");
});

test("listEvents respects the limit", () => {
  repo.add("device-a", "A");
  for (let i = 0; i < 5; i++) repo.recordEvent("device-a", "screenshot", `shot ${i}`);
  expect(repo.listEvents("device-a", 2)).toHaveLength(2);
});

test("enable does not disturb other enrolled devices", () => {
  repo.add("dev-1", "S10");
  repo.add("dev-2", "Pixel");

  repo.enable("dev-1");
  repo.enable("dev-2");

  expect(repo.listEnrolled().map((d) => d.id).sort()).toEqual(["dev-1", "dev-2"]);
});

test("disable removes a device from the pool without touching the others", () => {
  repo.add("dev-1", "S10");
  repo.add("dev-2", "Pixel");
  repo.enable("dev-1");
  repo.enable("dev-2");

  repo.disable("dev-1");

  expect(repo.listEnrolled().map((d) => d.id)).toEqual(["dev-2"]);
  expect(repo.get("dev-1")?.isActive).toBe(false);
});

test("remove deletes the device and its events", () => {
  repo.add("dev-1", "S10");
  repo.recordEvent("dev-1", "added", "by test");

  repo.remove("dev-1");

  expect(repo.get("dev-1")).toBeUndefined();
  expect(repo.listEvents("dev-1")).toEqual([]);
});

test("listEnrolled orders by addition time so dispatch is deterministic", () => {
  repo.add("dev-2", "Pixel");
  repo.add("dev-1", "S10");
  repo.enable("dev-2");
  repo.enable("dev-1");

  expect(repo.listEnrolled().map((d) => d.id)).toEqual(["dev-2", "dev-1"]);
});
