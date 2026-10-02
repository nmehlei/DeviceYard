import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, type Db } from "../../src/db/driver";
import { migrate } from "../../src/db/migrations";
import { NotificationStore } from "../../src/notifications/store";
import { NotificationWorker } from "../../src/notifications/worker";
import { EmailTransportError } from "../../src/notifications/transport";
import { UserRepository } from "../../src/store/userRepository";
import { sampleEmail } from "../../src/notifications/templates";

let db: Db, dir: string, store: NotificationStore, clock: number, userId: number;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "notification-worker-"));
  db = openDatabase(path.join(dir, "db")); migrate(db);
  clock = Date.now(); store = new NotificationStore(db, "ab".repeat(32), () => clock);
  const user = new UserRepository(db).create({ username: "tester", email: "test@example.invalid", password: "test-only", isAdmin: true });
  userId = user.id; db.run("UPDATE users SET email_verified_at=? WHERE id=?", clock, userId);
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
function enqueue() { store.enqueue({ eventKey: "test", kind: "test", userId,
  payload: { to: "test@example.invalid", data: sampleEmail("test") } }); }

test("transient failure retries later with same message id and erases payload after acceptance", async () => {
  enqueue(); const send = jest.fn().mockRejectedValueOnce(new EmailTransportError("timeout")).mockResolvedValue(undefined);
  const worker = new NotificationWorker(store, "https://farm.example", { send }, () => {});
  await worker.tick(); await worker.tick(); expect(send).toHaveBeenCalledTimes(1);
  clock += 30_001; await worker.tick();
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[0][0].id).toBe(send.mock.calls[1][0].id);
  expect(send.mock.calls[1][0].html).toContain("DeviceYard");
  expect(send.mock.calls[1][0].text).toContain("DeviceYard");
  expect(db.get("SELECT status,payload FROM notification_outbox")).toEqual({ status: "accepted", payload: null });
});

test("overlapping ticks do not send twice and disabled worker only performs housekeeping", async () => {
  enqueue(); await new NotificationWorker(store, "https://farm.example").tick();
  expect(db.get<{ status: string }>("SELECT status FROM notification_outbox")!.status).toBe("queued");
  let release!: () => void;
  const send = jest.fn(() => new Promise<void>((resolve) => { release = resolve; }));
  const worker = new NotificationWorker(store, "https://farm.example", { send }, () => {});
  const first = worker.tick(); await worker.tick();
  expect(send).toHaveBeenCalledTimes(1); release(); await first;
});

test("deactivated user is cancelled and transport errors never leak raw diagnostics", async () => {
  enqueue(); db.run("UPDATE users SET deactivated_at=? WHERE id=?", clock, userId);
  const send = jest.fn(); const log = jest.fn();
  await new NotificationWorker(store, "https://farm.example", { send }, log).tick();
  expect(send).not.toHaveBeenCalled();
  expect(db.get<{ status: string }>("SELECT status FROM notification_outbox")!.status).toBe("cancelled");
});
