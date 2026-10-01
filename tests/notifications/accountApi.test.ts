import express from "express";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { openDatabase, type Db } from "../../src/db/driver";
import { migrate } from "../../src/db/migrations";
import { accountActionRoutes } from "../../src/api/accountActions";
import { attachUserFromCookie } from "../../src/auth";
import { NotificationStore, type Delivery } from "../../src/notifications/store";
import type { QueuedEmail } from "../../src/notifications/worker";
import type { NotificationConfig } from "../../src/notifications/config";
import { UserRepository } from "../../src/store/userRepository";
import { OrgRepository } from "../../src/store/orgRepository";
import { signSession } from "../../src/session";

const SESSION_SECRET = "account-api-test-session";
const READY: NotificationConfig = {
  enabled: true,
  status: "ready",
  config: {
    host: "127.0.0.1", port: 1025, secure: false, tlsMode: "none",
    from: "notifications@example.invalid", fromName: "DeviceYard",
    publicUrl: new URL("http://localhost:3000"), connectionTimeoutMs: 1000, sendTimeoutMs: 1000,
  },
};

let db: Db;
let dir: string;
let store: NotificationStore;
let users: UserRepository;
let orgs: OrgRepository;
let servers: Map<string, Server>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "account-api-"));
  db = openDatabase(path.join(dir, "db"));
  migrate(db);
  store = new NotificationStore(db, "ab".repeat(32));
  users = new UserRepository(db);
  orgs = new OrgRepository(db);
  servers = new Map();
});

afterEach(async () => {
  await Promise.all([...servers.values()].map((server) => new Promise<void>((resolve, reject) => {
    server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve());
  })));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function app(config: NotificationConfig = READY) {
  const existing = servers.get(config.status); if (existing) return existing;
  const instance = express();
  instance.set("trust proxy", false);
  instance.use(express.json());
  instance.use(attachUserFromCookie(users, SESSION_SECRET));
  instance.use(accountActionRoutes({ store, config }));
  const server = instance.listen(0);
  servers.set(config.status, server);
  return server;
}

function cookie(userId: number): string {
  return `mdf_session=${signSession(userId, Date.now() + 60_000, SESSION_SECRET, users.sessionVersion(userId))}`;
}

function actionToken(actionId: string): string {
  const delivery = db.get<Delivery>("SELECT * FROM notification_outbox WHERE action_id=?", actionId)!;
  const queued = store.decode<QueuedEmail>(delivery);
  return new URLSearchParams(new URL(queued.data.actionUrl, "https://example.invalid").hash.slice(1)).get("token")!;
}

describe("account action HTTP API", () => {
  test("password reset gives the same generic response for existing and missing accounts", async () => {
    users.create({ username: "alex", email: "alex@example.invalid", password: "old-password", isAdmin: false });
    const existing = await request(app()).post("/api/account/password-reset").send({ email: "alex@example.invalid" });
    const missing = await request(app()).post("/api/account/password-reset").send({ email: "missing@example.invalid" });
    expect(existing.status).toBe(202);
    expect(missing.status).toBe(202);
    expect(missing.body).toEqual(existing.body);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM notification_actions")!.count).toBe(1);
  });

  test("email-dependent issuance is unavailable without configured mail", async () => {
    const response = await request(app({ enabled: false, status: "disabled" }))
      .post("/api/account/password-reset").send({ email: "alex@example.invalid" });
    expect(response.status).toBe(503);
    expect(response.body.error).toMatch(/Email is not configured/);
  });

  test("password reset is rate limited without revealing account existence", async () => {
    const instance = app();
    for (let index = 0; index < 10; index++) {
      expect((await request(instance).post("/api/account/password-reset").send({ email: `missing-${index}@example.invalid` })).status).toBe(202);
    }
    const limited = await request(instance).post("/api/account/password-reset").send({ email: "another@example.invalid" });
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: "Too many requests. Please try again later." });
  });

  test("inspection is scanner-safe and does not consume the action", async () => {
    const account = users.create({ username: "alex", email: "alex@example.invalid", password: "old-password", isAdmin: false });
    await request(app()).post("/api/account/password-reset").send({ email: account.email });
    const action = db.get<{ id: string }>("SELECT id FROM notification_actions WHERE user_id=?", account.id)!;
    const token = actionToken(action.id);
    const first = await request(app()).post("/api/account/actions/inspect").send({ token });
    const second = await request(app()).post("/api/account/actions/inspect").send({ token });
    expect(first.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(first.body).toMatchObject({ kind: "password-reset", existingAccount: true });
    expect(db.get<{ consumed_at: number | null }>("SELECT consumed_at FROM notification_actions WHERE id=?", action.id)!.consumed_at).toBeNull();
  });

  test("verification issuance requires a cookie session and rejects bearer plus cookie", async () => {
    const account = users.create({ username: "alex", email: "alex@example.invalid", password: "old-password", isAdmin: false });
    expect((await request(app()).post("/api/account/verify-email")).status).toBe(401);
    expect((await request(app()).post("/api/account/verify-email").set("Cookie", cookie(account.id)).set("Authorization", "Bearer ci-token")).status).toBe(401);
    expect((await request(app()).post("/api/account/verify-email").set("Cookie", cookie(account.id))).status).toBe(202);
  });

  test("a user cannot list or issue invitations for another organisation", async () => {
    const owner = users.create({ username: "owner", email: "owner@example.invalid", password: "old-password", isAdmin: false });
    const outsider = users.create({ username: "outsider", email: "outsider@example.invalid", password: "old-password", isAdmin: false });
    const org = orgs.create("private-team", [owner.id]);
    expect((await request(app()).get(`/api/orgs/${org.id}/invitations`).set("Cookie", cookie(outsider.id))).status).toBe(404);
    expect((await request(app()).post(`/api/orgs/${org.id}/invitations`).set("Cookie", cookie(outsider.id)).send({ email: "new@example.invalid" })).status).toBe(404);
  });

  test("resend invalidates the previous invitation and revoke invalidates the replacement", async () => {
    const owner = users.create({ username: "owner", email: "owner@example.invalid", password: "old-password", isAdmin: false });
    const org = orgs.create("team", [owner.id]);
    const instance = app();
    const issued = await request(instance).post(`/api/orgs/${org.id}/invitations`).set("Cookie", cookie(owner.id)).send({ email: "new@example.invalid" });
    expect(issued.status).toBe(202);
    const oldToken = actionToken(issued.body.id);
    const resent = await request(instance).post(`/api/orgs/${org.id}/invitations/${issued.body.id}/resend`).set("Cookie", cookie(owner.id));
    expect(resent.status).toBe(202);
    const newToken = actionToken(resent.body.id);
    expect((await request(instance).post("/api/account/actions/inspect").send({ token: oldToken })).status).toBe(400);
    expect((await request(instance).post("/api/account/actions/inspect").send({ token: newToken })).status).toBe(200);
    expect((await request(instance).delete(`/api/orgs/${org.id}/invitations/${resent.body.id}`).set("Cookie", cookie(owner.id))).status).toBe(204);
    expect((await request(instance).post("/api/account/actions/inspect").send({ token: newToken })).status).toBe(400);
  });

  test("organisation invitation mutations reject bearer plus cookie", async () => {
    const owner = users.create({ username: "owner", email: "owner@example.invalid", password: "old-password", isAdmin: false });
    const org = orgs.create("team", [owner.id]);
    const response = await request(app()).post(`/api/orgs/${org.id}/invitations`)
      .set("Cookie", cookie(owner.id)).set("Authorization", "Bearer ci-token").send({ email: "new@example.invalid" });
    expect(response.status).toBe(401);
  });

  test("password reset invalidates the old cookie through the real middleware", async () => {
    const account = users.create({ username: "alex", email: "alex@example.invalid", password: "old-password", isAdmin: false });
    const oldCookie = cookie(account.id);
    await request(app()).post("/api/account/password-reset").send({ email: account.email });
    const action = db.get<{ id: string }>("SELECT id FROM notification_actions WHERE user_id=?", account.id)!;
    const redeemed = await request(app()).post("/api/account/actions/redeem")
      .send({ token: actionToken(action.id), kind: "password-reset", password: "new-password" });
    expect(redeemed.status).toBe(200);
    expect(users.verifyCredentials("alex", "new-password")?.id).toBe(account.id);
    expect((await request(app()).post("/api/account/verify-email").set("Cookie", oldCookie)).status).toBe(401);
  });
});
