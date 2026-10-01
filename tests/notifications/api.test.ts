import express from "express";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, type Db } from "../../src/db/driver";
import { migrate } from "../../src/db/migrations";
import { NotificationStore } from "../../src/notifications/store";
import { notificationRoutes } from "../../src/api/notifications";
import { UserRepository } from "../../src/store/userRepository";
import { OrgRepository } from "../../src/store/orgRepository";
import { attachUserFromCookie } from "../../src/auth";
import { signSession } from "../../src/session";

let db: Db, dir: string, store: NotificationStore, users: UserRepository;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "notification-api-"));
  db = openDatabase(path.join(dir, "db")); migrate(db);
  store = new NotificationStore(db, "ab".repeat(32)); users = new UserRepository(db);
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
function app() {
  const app = express(); app.use(express.json()); app.use(attachUserFromCookie(users, "test-session"));
  app.use(notificationRoutes({ store, config: { enabled: false, status: "disabled" } })); return app;
}
function cookie(id: number) { return `mdf_session=${signSession(id, Date.now() + 60_000, "test-session")}`; }

test("settings default off and cannot target another organisation or enable unavailable mail", async () => {
  const user = users.create({ username: "tester", email: "test@example.invalid", password: "test-only", isAdmin: false });
  const orgs = new OrgRepository(db); const own = orgs.create("own", [user.id]); const other = orgs.create("other", []);
  const response = await request(app()).get("/api/me/notifications").set("Cookie", cookie(user.id));
  expect(response.body.orgs).toEqual([{ orgId: own.id, orgName: "own", run: "off" }]);
  expect(response.body.verified).toBe(false);
  expect((await request(app()).put("/api/me/notifications").set("Cookie", cookie(user.id))
    .send({ orgs: [{ orgId: other.id, run: "off" }], deviceHealth: false })).status).toBe(403);
  expect((await request(app()).put("/api/me/notifications").set("Cookie", cookie(user.id))
    .send({ orgs: [{ orgId: own.id, run: "failures" }], deviceHealth: false })).status).toBe(409);
});

test("previews are synthetic and session-only; history is admin-only without payloads", async () => {
  const user = users.create({ username: "tester", email: "test@example.invalid", password: "test-only", isAdmin: false });
  expect((await request(app()).get("/api/notifications/templates/password-reset")).status).toBe(401);
  const response = await request(app()).get("/api/notifications/templates/password-reset").set("Cookie", cookie(user.id));
  expect(response.status).toBe(200); expect(response.body.html).not.toContain("test@example.invalid");
  expect((await request(app()).get("/api/admin/notifications/history").set("Cookie", cookie(user.id))).status).toBe(403);
  expect((await request(app()).get("/api/me/notifications").set("Cookie", cookie(user.id)).set("Authorization", "Bearer example")).status).toBe(401);
});

test("SMTP unavailability does not prevent a partial opt-out", async () => {
  const user = users.create({ username: "tester", email: "test@example.invalid", password: "test-only", isAdmin: false });
  const orgs = new OrgRepository(db); const first = orgs.create("first", [user.id]); const second = orgs.create("second", [user.id]);
  db.run("INSERT INTO notification_preferences VALUES (?,?,'all')", user.id, first.id);
  db.run("INSERT INTO notification_preferences VALUES (?,?,'all')", user.id, second.id);
  const response = await request(app()).put("/api/me/notifications").set("Cookie", cookie(user.id))
    .send({ orgs: [{ orgId: first.id, run: "off" }, { orgId: second.id, run: "all" }], deviceHealth: false });
  expect(response.status).toBe(200);
  expect(response.body.orgs[0].run).toBe("off");
});
