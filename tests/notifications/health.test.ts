import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, type Db } from "../../src/db/driver";
import { migrate } from "../../src/db/migrations";
import { NotificationStore } from "../../src/notifications/store";
import { DeviceHealthMonitor, HEALTH_POLL_MS, OFFLINE_DEBOUNCE_MS } from "../../src/notifications/health";
import { UserRepository } from "../../src/store/userRepository";
import { DeviceRepository } from "../../src/store/deviceRepository";

let db: Db, dir: string, store: NotificationStore, monitor: DeviceHealthMonitor, clock: number;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "notification-health-"));
  db = openDatabase(path.join(dir, "db")); migrate(db); clock = Date.now();
  store = new NotificationStore(db, "ab".repeat(32), () => clock); monitor = new DeviceHealthMonitor(store);
  new DeviceRepository(db).seedIfEmpty("device");
  const user = new UserRepository(db).create({ username: "tester", email: "test@example.invalid", password: "test-only", isAdmin: true });
  db.run("UPDATE users SET email_verified_at=? WHERE id=?", clock, user.id);
  db.run("INSERT INTO notification_health_preferences VALUES (?,1)", user.id);
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
function observe(online: boolean) { monitor.observe("device", "Lab device", online); clock += HEALTH_POLL_MS; }
function outage() { for (let i = 0; i <= OFFLINE_DEBOUNCE_MS / HEALTH_POLL_MS; i++) observe(false); }

test("short disconnect is silent; continuous outage alerts once and accepted recipients get recovery", () => {
  observe(true); observe(false); observe(true);
  expect(store.claim()).toBeUndefined();
  outage(); const delivery = store.claim()!;
  expect(delivery.kind).toBe("device-offline"); expect(store.eligible(delivery)).toBe(true);
  store.finish(delivery, "accepted"); observe(false); expect(store.claim()).toBeUndefined();
  observe(true); const recovery = store.claim()!;
  expect(recovery.kind).toBe("device-recovered"); expect(store.eligible(recovery)).toBe(true);
  store.finish(recovery, "accepted"); observe(true); expect(store.claim()).toBeUndefined();
});

test("recovery cancels an unsent outage and sends no unmatched recovery", () => {
  observe(true); outage(); observe(true);
  expect(store.claim()).toBeUndefined();
  expect(db.get<{ status: string }>("SELECT status FROM notification_outbox")!.status).toBe("cancelled");
});

test("monitor recreation retains a continuously observed debounce", () => {
  observe(true); observe(false); observe(false);
  monitor = new DeviceHealthMonitor(store); outage();
  expect(db.all("SELECT * FROM notification_outbox")).toHaveLength(1);
});

test("recovery catches SMTP acceptance that lands after the online observation", () => {
  observe(true); outage(); const sending = store.claim()!;
  observe(true); store.finish(sending, "accepted"); observe(true);
  expect(store.claim()!.kind).toBe("device-recovered");
});

test("a fresh outage cannot erase recovery for an earlier in-flight send", () => {
  observe(true); outage(); const sending = store.claim()!;
  observe(true); observe(false); store.finish(sending, "accepted");
  monitor.expandRecoveries();
  expect(store.claim()!.kind).toBe("device-recovered");
});

test("unobserved time does not count toward pending outage delivery", () => {
  observe(true); outage(); clock += 120_000;
  expect(store.claim()).toBeUndefined(); observe(false);
  expect(store.claim()).toBeUndefined(); outage();
  expect(store.claim()!.kind).toBe("device-offline");
});
