import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, type Db } from "../../src/db/driver";
import { migrate } from "../../src/db/migrations";
import { NotificationStore, LEASE_MS, DAY_MS } from "../../src/notifications/store";
import { UserRepository } from "../../src/store/userRepository";
import { OrgRepository } from "../../src/store/orgRepository";
import { JobRepository } from "../../src/store/jobRepository";

let db: Db, dir: string, store: NotificationStore, clock: number;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "notifications-"));
  db = openDatabase(path.join(dir, "farm.db")); migrate(db);
  clock = Date.now(); store = new NotificationStore(db, "ab".repeat(32), () => clock);
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("encrypted payload survives reopening; unique event does not enqueue twice", () => {
  const input = { eventKey: "one", kind: "test", payload: { marker: "private-action-value" } };
  const id = store.enqueue(input);
  expect(store.enqueue(input)).toBe(id);
  expect(db.get<{ payload: string }>("SELECT payload FROM notification_outbox")!.payload).not.toContain("private-action-value");
  db.close(); db = openDatabase(path.join(dir, "farm.db"));
  store = new NotificationStore(db, "ab".repeat(32), () => clock);
  const claim = store.claim()!;
  expect(store.decode(claim)).toEqual(input.payload);
  expect(store.claim()).toBeUndefined();
  store.finish(claim, "accepted");
  expect(db.get<{ payload: null; status: string }>("SELECT payload,status FROM notification_outbox")).toEqual({ payload: null, status: "accepted" });
});

test("expired lease is reclaimable and stale owner cannot finish it", () => {
  store.enqueue({ eventKey: "one", kind: "test", payload: {} });
  const old = store.claim()!; clock += LEASE_MS + 1;
  const current = store.claim()!;
  expect(current.lease_owner).not.toBe(old.lease_owner);
  store.finish(old, "accepted");
  expect(db.get<{ status: string }>("SELECT status FROM notification_outbox")!.status).toBe("sending");
  store.finish(current, "accepted");
  expect(db.all("SELECT * FROM notification_attempts")).toHaveLength(1);
});

test("expiration erases unsent payload and rate limits survive store recreation", () => {
  store.enqueue({ eventKey: "one", kind: "test", payload: {} });
  expect(store.allow("requester", 1, 1000)).toBe(true);
  expect(new NotificationStore(db, "ab".repeat(32), () => clock).allow("requester", 1, 1000)).toBe(false);
  clock += DAY_MS + 1; store.sweep();
  expect(store.claim()).toBeUndefined();
  expect(db.get<{ payload: null }>("SELECT payload FROM notification_outbox")!.payload).toBeNull();
});

test("terminal done job with a failed flow captures eligible subscribers once and rechecks opt out", () => {
  const user = new UserRepository(db).create({ username: "tester", email: "test@example.invalid", password: "test-only", isAdmin: false });
  const orgs = new OrgRepository(db); const org = orgs.create("example", [user.id]);
  db.run("UPDATE users SET email_verified_at=? WHERE id=?", clock, user.id);
  db.run("INSERT INTO notification_preferences VALUES (?,?,?)", user.id, org.id, "failures");
  const jobs = new JobRepository(db, () => clock);
  const job = jobs.createJob(org.name, ["checkout"]);
  const step = jobs.startStep(job.id, "checkout"); jobs.finishStep(step.id, { status: "failed" });
  jobs.finishJob(job.id, "done"); jobs.finishJob(job.id, "done");
  expect(db.all("SELECT * FROM notification_events")).toHaveLength(1);
  store.expandRunEvents((snapshot) => ({ failed: !!snapshot.failed, snapshot }));
  const delivery = store.claim()!;
  expect(store.eligible(delivery)).toBe(true);
  expect(store.decode<{ snapshot: { failedCount: number } }>(delivery).snapshot.failedCount).toBe(1);
  db.run("UPDATE notification_preferences SET mode='off'");
  expect(store.eligible(delivery)).toBe(false);
});

test("restart reconciliation captures infrastructure failures without historical backfill", () => {
  const org = new OrgRepository(db).create("example", []);
  const jobs = new JobRepository(db, () => clock);
  const job = jobs.createJob(org.name, ["checkout"]);
  jobs.markJobRunning(job.id);
  expect(jobs.reconcileInterrupted()).toBe(1);
  const event = db.get<{ payload: string }>("SELECT payload FROM notification_events")!;
  expect(JSON.parse(event.payload).failed).toBe(1);
  db.run("DELETE FROM notification_events"); migrate(db);
  expect(db.all("SELECT * FROM notification_events")).toHaveLength(0);
});
