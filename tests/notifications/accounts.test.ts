import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, type Db } from "../../src/db/driver";
import { migrate } from "../../src/db/migrations";
import { NotificationStore, type Delivery } from "../../src/notifications/store";
import { AccountActions } from "../../src/notifications/accounts";
import { UserRepository } from "../../src/store/userRepository";
import { UserTokenRepository } from "../../src/store/userTokenRepository";
import { OrgRepository } from "../../src/store/orgRepository";
import { signSession, verifySession } from "../../src/session";
import type { QueuedEmail } from "../../src/notifications/worker";

let db: Db, dir: string, store: NotificationStore, actions: AccountActions, users: UserRepository, clock: number;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "notification-actions-")); db = openDatabase(path.join(dir, "db")); migrate(db);
  clock = Date.now(); store = new NotificationStore(db, "ab".repeat(32), () => clock); actions = new AccountActions(store); users = new UserRepository(db);
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
function token(id: string): string {
  const delivery = db.get<Delivery>("SELECT * FROM notification_outbox WHERE action_id=?", id)!;
  const data = store.decode<QueuedEmail>(delivery).data;
  return new URLSearchParams(new URL(data.actionUrl, "https://example.invalid").hash.slice(1)).get("token")!;
}
function user() { return users.create({ username: "tester", email: "test@example.invalid", password: "original-password", isAdmin: true }); }

test("reset atomically revokes sessions and PATs, is single use, and cannot be consumed by inspection", () => {
  const account = user(); const patRepo = new UserTokenRepository(db, "ab".repeat(32));
  patRepo.generateAndCreate(account.id, "test");
  const cookie = signSession(account.id, clock + 60_000, "session");
  const id = actions.issue("password-reset", account.email, account.id); const raw = token(id);
  expect(actions.inspect(raw).kind).toBe("password-reset"); expect(actions.inspect(raw).kind).toBe("password-reset");
  actions.redeem(raw, "password-reset", { password: "new-password" });
  expect(users.verifyCredentials(account.username, "new-password")?.id).toBe(account.id);
  expect(verifySession(cookie, "session", clock, (id) => users.sessionVersion(id))).toBeUndefined();
  expect(patRepo.list(account.id)).toHaveLength(0);
  expect(() => actions.redeem(raw, "password-reset", { password: "another-password" })).toThrow("invalid or expired");
  expect(db.get<{ payload: null }>("SELECT payload FROM notification_outbox WHERE action_id=?", id)!.payload).toBeNull();
});

test("resend invalidates old link, expiration and wrong purpose cannot redeem", () => {
  const account = user(); const old = token(actions.issue("email-verification", account.email, account.id));
  const fresh = token(actions.issue("email-verification", account.email, account.id));
  expect(() => actions.inspect(old)).toThrow("invalid or expired");
  expect(() => actions.redeem(fresh, "password-reset", { password: "new-password" })).toThrow("invalid or expired");
  clock += 86_400_001; expect(() => actions.inspect(fresh)).toThrow("invalid or expired");
});

test("invitation creates ordinary member, preserves replay protection and existing account requires matching login", () => {
  const admin = user(); const orgs = new OrgRepository(db); const org = orgs.create("team", [admin.id]);
  const raw = token(actions.issue("invitation", "new@example.invalid", undefined, org.id, admin.id));
  actions.redeem(raw, "invitation", { username: "new-user", password: "new-password" });
  const joined = users.getByUsername("new-user")!;
  expect(joined.isAdmin).toBe(false); expect(orgs.isMember(joined.id, org.id)).toBe(true);
  expect(() => actions.redeem(raw, "invitation", { username: "another", password: "new-password" })).toThrow("invalid or expired");
  const invite = token(actions.issue("invitation", joined.email, undefined, org.id, admin.id));
  expect(() => actions.redeem(invite, "invitation", { signedInUserId: admin.id })).toThrow("invited account");
  actions.redeem(invite, "invitation", { signedInUserId: joined.id });
});

test("removed inviter and deactivated reset account cannot redeem", () => {
  const admin = user(); const orgs = new OrgRepository(db); const org = orgs.create("team", [admin.id]);
  const invite = token(actions.issue("invitation", "new@example.invalid", undefined, org.id, admin.id));
  const reset = token(actions.issue("password-reset", admin.email, admin.id));
  users.deactivate(admin.id);
  expect(() => actions.redeem(invite, "invitation", { username: "new-user", password: "new-password" })).toThrow("no longer available");
  expect(() => actions.redeem(reset, "password-reset", { password: "new-password" })).toThrow("invalid or expired");
});
