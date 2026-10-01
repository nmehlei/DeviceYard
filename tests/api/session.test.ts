import request from "supertest";
import express from "express";
import { sessionRoutes } from "../../src/api/session";
import { attachUserFromCookie } from "../../src/auth";
import { SESSION_COOKIE } from "../../src/session";
import { openDatabase, type Db } from "../../src/db/driver";
import { migrate } from "../../src/db/migrations";
import fs from "fs";
import os from "os";
import path from "path";
import { UserRepository } from "../../src/store/userRepository";
import { OrgRepository } from "../../src/store/orgRepository";

const SECRET = "test-secret";

let dir: string;
let db: Db;
let userRepo: UserRepository;
let orgRepo: OrgRepository;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-session-api-"));
  db = openDatabase(path.join(dir, "farm.db"));
  migrate(db);
  userRepo = new UserRepository(db);
  orgRepo = new OrgRepository(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function app() {
  const a = express();
  a.use(express.json());
  a.use(attachUserFromCookie(userRepo, SECRET));
  a.use(sessionRoutes({ userRepo, orgRepo, sessionSecret: SECRET }));
  return a;
}

test("a valid username+password is exchanged for an httpOnly session cookie and returns user+orgs", async () => {
  const user = userRepo.create({ username: "nicolas", email: "n@example.com", password: "correct-password", isAdmin: false });
  const org = orgRepo.create("donable", [user.id]);

  const res = await request(app()).post("/api/session").send({ username: "nicolas", password: "correct-password" });

  expect(res.status).toBe(200);
  expect(res.body.user).toEqual({ id: user.id, username: "nicolas", email: "n@example.com", isAdmin: false });
  expect(res.body.orgs).toEqual([{ id: org.id, name: "donable", archivedAt: null, createdAt: org.createdAt }]);

  const cookie = res.headers["set-cookie"][0];
  expect(cookie).toContain(`${SESSION_COOKIE}=`);
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Lax");
  expect(cookie).toContain("Secure");
  expect(cookie).not.toContain("correct-password");
});

test("an invalid password is rejected without setting a cookie", async () => {
  userRepo.create({ username: "nicolas", email: "n@example.com", password: "correct-password", isAdmin: false });
  const res = await request(app()).post("/api/session").send({ username: "nicolas", password: "wrong" });

  expect(res.status).toBe(403);
  expect(res.body).toEqual({ error: "invalid username or password" });
  expect(res.headers["set-cookie"]).toBeUndefined();
});

test("an unknown username gets the same error as a wrong password - no username enumeration", async () => {
  const res = await request(app()).post("/api/session").send({ username: "nobody", password: "anything" });
  expect(res.status).toBe(403);
  expect(res.body).toEqual({ error: "invalid username or password" });
});

test("a deactivated user's correct password is still rejected with the same generic error", async () => {
  const user = userRepo.create({ username: "gone", email: "g@example.com", password: "correct-password", isAdmin: false });
  userRepo.deactivate(user.id);
  const res = await request(app()).post("/api/session").send({ username: "gone", password: "correct-password" });
  expect(res.status).toBe(403);
  expect(res.body).toEqual({ error: "invalid username or password" });
});

test("missing username or password is a 400", async () => {
  const res = await request(app()).post("/api/session").send({ username: "nicolas" });
  expect(res.status).toBe(400);
  expect(res.body).toEqual({ error: "username and password are required" });
});

test("GET /api/session returns the current user and their orgs when logged in", async () => {
  const user = userRepo.create({ username: "nicolas", email: "n@example.com", password: "x", isAdmin: false });
  orgRepo.create("donable", [user.id]);
  const login = await request(app()).post("/api/session").send({ username: "nicolas", password: "x" });
  const cookie = login.headers["set-cookie"][0];

  const res = await request(app()).get("/api/session").set("Cookie", cookie);
  expect(res.status).toBe(200);
  expect(res.body.user.username).toBe("nicolas");
  expect(res.body.orgs).toHaveLength(1);
});

test("GET /api/session without a cookie is a 401", async () => {
  const res = await request(app()).get("/api/session");
  expect(res.status).toBe(401);
});

test("DELETE clears the cookie", async () => {
  const res = await request(app()).delete("/api/session");
  expect(res.status).toBe(204);
  expect(res.headers["set-cookie"][0]).toContain(`${SESSION_COOKIE}=;`);
});

async function loggedInCookie(username: string, password: string): Promise<string> {
  const login = await request(app()).post("/api/session").send({ username, password });
  return login.headers["set-cookie"][0];
}

test("PATCH /api/session/password changes the password when the current password is correct", async () => {
  userRepo.create({ username: "nicolas", email: "n@example.com", password: "old-password", isAdmin: false });
  const cookie = await loggedInCookie("nicolas", "old-password");

  const res = await request(app())
    .patch("/api/session/password")
    .set("Cookie", cookie)
    .send({ currentPassword: "old-password", newPassword: "new-password-123" });

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ ok: true });

  // The old password no longer works, the new one does - proves setPassword
  // actually ran, not just that the route returned 200.
  const oldStillWorks = await request(app()).post("/api/session").send({ username: "nicolas", password: "old-password" });
  expect(oldStillWorks.status).toBe(403);
  const newWorks = await request(app()).post("/api/session").send({ username: "nicolas", password: "new-password-123" });
  expect(newWorks.status).toBe(200);
});

test("PATCH /api/session/password rejects an incorrect current password without changing anything", async () => {
  userRepo.create({ username: "nicolas", email: "n@example.com", password: "old-password", isAdmin: false });
  const cookie = await loggedInCookie("nicolas", "old-password");

  const res = await request(app())
    .patch("/api/session/password")
    .set("Cookie", cookie)
    .send({ currentPassword: "wrong-password", newPassword: "new-password-123" });

  expect(res.status).toBe(403);
  expect(res.body).toEqual({ error: "current password is incorrect" });

  const stillOld = await request(app()).post("/api/session").send({ username: "nicolas", password: "old-password" });
  expect(stillOld.status).toBe(200);
});

test("PATCH /api/session/password rejects a too-short new password before checking the current one", async () => {
  userRepo.create({ username: "nicolas", email: "n@example.com", password: "old-password", isAdmin: false });
  const cookie = await loggedInCookie("nicolas", "old-password");

  const res = await request(app())
    .patch("/api/session/password")
    .set("Cookie", cookie)
    .send({ currentPassword: "old-password", newPassword: "short" });

  expect(res.status).toBe(400);
  expect(res.body).toEqual({ error: "password must be at least 8 characters" });

  const stillOld = await request(app()).post("/api/session").send({ username: "nicolas", password: "old-password" });
  expect(stillOld.status).toBe(200);
});

test("PATCH /api/session/password without a cookie is a 401", async () => {
  const res = await request(app())
    .patch("/api/session/password")
    .send({ currentPassword: "x", newPassword: "new-password-123" });
  expect(res.status).toBe(401);
});

test("PATCH /api/session/password is a 400 when currentPassword or newPassword is missing", async () => {
  userRepo.create({ username: "nicolas", email: "n@example.com", password: "old-password", isAdmin: false });
  const cookie = await loggedInCookie("nicolas", "old-password");

  const res = await request(app()).patch("/api/session/password").set("Cookie", cookie).send({ newPassword: "new-password-123" });
  expect(res.status).toBe(400);
  expect(res.body).toEqual({ error: "currentPassword and newPassword are required" });
});
