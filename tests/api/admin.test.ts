import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import express from "express";
import { adminRoutes } from "../../src/api/admin";
import { openDatabase, type Db } from "../../src/db/driver";
import { migrate } from "../../src/db/migrations";
import { UserRepository } from "../../src/store/userRepository";
import { OrgRepository } from "../../src/store/orgRepository";
import { JobRepository } from "../../src/store/jobRepository";

let dir: string;
let db: Db;
let userRepo: UserRepository;
let orgRepo: OrgRepository;
let repo: JobRepository;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-admin-routes-"));
  db = openDatabase(path.join(dir, "farm.db"));
  migrate(db);
  userRepo = new UserRepository(db);
  orgRepo = new OrgRepository(db);
  repo = new JobRepository(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function app(opts: { userId?: number; isAdmin?: boolean }) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    if (opts.userId !== undefined) req.userId = opts.userId;
    req.isAdmin = opts.isAdmin ?? false;
    next();
  });
  a.use(adminRoutes({ orgRepo, userRepo, repo }));
  return a;
}

test("a non-admin gets 403 on every admin route", async () => {
  const nonAdmin = userRepo.create({ username: "a", email: "a@example.com", password: "x", isAdmin: false });
  const res = await request(app({ userId: nonAdmin.id, isAdmin: false })).get("/api/admin/orgs");
  expect(res.status).toBe(403);
});

test("an admin can list all orgs, including archived ones", async () => {
  const admin = userRepo.create({ username: "admin", email: "ad@example.com", password: "x", isAdmin: true });
  const org = orgRepo.create("donable", [admin.id]);
  orgRepo.archive(org.id);

  const res = await request(app({ userId: admin.id, isAdmin: true })).get("/api/admin/orgs");
  expect(res.status).toBe(200);
  expect(res.body.orgs).toHaveLength(1);
});

test("an admin can create an org, defaulting initial membership to themselves", async () => {
  const admin = userRepo.create({ username: "admin", email: "ad@example.com", password: "x", isAdmin: true });
  const res = await request(app({ userId: admin.id, isAdmin: true })).post("/api/admin/orgs").send({ name: "acme" });

  expect(res.status).toBe(201);
  expect(res.body.org.name).toBe("acme");
  expect(orgRepo.isMember(admin.id, res.body.org.id)).toBe(true);
});

test("creating an org with an explicit empty initialMemberUserIds array still adds the creating admin as a member (I4)", async () => {
  const admin = userRepo.create({ username: "admin", email: "ad@example.com", password: "x", isAdmin: true });
  const res = await request(app({ userId: admin.id, isAdmin: true }))
    .post("/api/admin/orgs")
    .send({ name: "acme", initialMemberUserIds: [] });

  expect(res.status).toBe(201);
  expect(orgRepo.isMember(admin.id, res.body.org.id)).toBe(true);
  expect(orgRepo.listMembers(res.body.org.id)).toHaveLength(1);
});

test("creating a duplicate org name is a 409", async () => {
  const admin = userRepo.create({ username: "admin", email: "ad@example.com", password: "x", isAdmin: true });
  orgRepo.create("acme", []);
  const res = await request(app({ userId: admin.id, isAdmin: true })).post("/api/admin/orgs").send({ name: "acme" });
  expect(res.status).toBe(409);
});

test("an admin can rename an org", async () => {
  const admin = userRepo.create({ username: "admin", email: "ad@example.com", password: "x", isAdmin: true });
  const org = orgRepo.create("old-name", []);
  const res = await request(app({ userId: admin.id, isAdmin: true })).patch(`/api/admin/orgs/${org.id}`).send({ name: "new-name" });
  expect(res.status).toBe(200);
  expect(res.body.org.name).toBe("new-name");
});

test("an admin can archive an org", async () => {
  const admin = userRepo.create({ username: "admin", email: "ad@example.com", password: "x", isAdmin: true });
  const org = orgRepo.create("donable", []);
  const res = await request(app({ userId: admin.id, isAdmin: true })).delete(`/api/admin/orgs/${org.id}`);
  expect(res.status).toBe(204);
  expect(orgRepo.getById(org.id)?.archivedAt).not.toBeNull();
});

test("an admin can create a user account", async () => {
  const admin = userRepo.create({ username: "admin", email: "ad@example.com", password: "x", isAdmin: true });
  const res = await request(app({ userId: admin.id, isAdmin: true }))
    .post("/api/admin/users")
    .send({ username: "newperson", email: "np@example.com", password: "a-real-password" });

  expect(res.status).toBe(201);
  expect(res.body.user).toMatchObject({ username: "newperson", email: "np@example.com", isAdmin: false });
});

test("creating a user with a short password is a 400", async () => {
  const admin = userRepo.create({ username: "admin", email: "ad@example.com", password: "x", isAdmin: true });
  const res = await request(app({ userId: admin.id, isAdmin: true }))
    .post("/api/admin/users")
    .send({ username: "newperson", email: "np@example.com", password: "short" });
  expect(res.status).toBe(400);
});

test("creating a duplicate username is a 409", async () => {
  const admin = userRepo.create({ username: "admin", email: "ad@example.com", password: "x", isAdmin: true });
  userRepo.create({ username: "taken", email: "t@example.com", password: "x", isAdmin: false });
  const res = await request(app({ userId: admin.id, isAdmin: true }))
    .post("/api/admin/users")
    .send({ username: "taken", email: "other@example.com", password: "a-real-password" });
  expect(res.status).toBe(409);
});

test("an admin can promote a user to admin and reset their password", async () => {
  const admin = userRepo.create({ username: "admin", email: "ad@example.com", password: "x", isAdmin: true });
  const target = userRepo.create({ username: "b", email: "b@example.com", password: "old-password", isAdmin: false });

  const res = await request(app({ userId: admin.id, isAdmin: true }))
    .patch(`/api/admin/users/${target.id}`)
    .send({ isAdmin: true, password: "new-password" });

  expect(res.status).toBe(200);
  expect(res.body.user.isAdmin).toBe(true);
  expect(userRepo.verifyCredentials("b", "new-password")).toBeDefined();
});

test("editing a user with a too-short password is a 400 and does not change the password (I5)", async () => {
  const admin = userRepo.create({ username: "admin", email: "ad@example.com", password: "x", isAdmin: true });
  const target = userRepo.create({ username: "b", email: "b@example.com", password: "old-password", isAdmin: false });

  const res = await request(app({ userId: admin.id, isAdmin: true }))
    .patch(`/api/admin/users/${target.id}`)
    .send({ password: "short" });

  expect(res.status).toBe(400);
  expect(userRepo.verifyCredentials("b", "old-password")).toBeDefined();
});

test("an admin can deactivate a user", async () => {
  const admin = userRepo.create({ username: "admin", email: "ad@example.com", password: "x", isAdmin: true });
  const target = userRepo.create({ username: "b", email: "b@example.com", password: "x", isAdmin: false });

  const res = await request(app({ userId: admin.id, isAdmin: true })).delete(`/api/admin/users/${target.id}`);
  expect(res.status).toBe(204);
  expect(userRepo.getById(target.id)?.deactivatedAt).not.toBeNull();
});

test("GET /api/admin/retention is 403 for a non-admin", async () => {
  const nonAdmin = userRepo.create({ username: "a", email: "a@example.com", password: "x", isAdmin: false });
  const res = await request(app({ userId: nonAdmin.id, isAdmin: false })).get("/api/admin/retention");
  expect(res.status).toBe(403);
});

test("GET /api/admin/retention returns all-disabled defaults when nothing has been saved", async () => {
  const admin = userRepo.create({ username: "admin", email: "ad@example.com", password: "x", isAdmin: true });
  const res = await request(app({ userId: admin.id, isAdmin: true })).get("/api/admin/retention");

  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ maxAgeDays: null, maxTotalBytes: null, maxJobs: null, totalArtifactBytes: 0 });
});

test("PUT /api/admin/retention saves settings and GET reflects them", async () => {
  const admin = userRepo.create({ username: "admin", email: "ad@example.com", password: "x", isAdmin: true });
  const putRes = await request(app({ userId: admin.id, isAdmin: true }))
    .put("/api/admin/retention")
    .send({ maxAgeDays: 14, maxTotalBytes: 1_000_000, maxJobs: null });

  expect(putRes.status).toBe(200);
  expect(putRes.body).toMatchObject({ maxAgeDays: 14, maxTotalBytes: 1_000_000, maxJobs: null });

  const getRes = await request(app({ userId: admin.id, isAdmin: true })).get("/api/admin/retention");
  expect(getRes.body).toMatchObject({ maxAgeDays: 14, maxTotalBytes: 1_000_000, maxJobs: null });
});

test("PUT /api/admin/retention rejects a negative or non-integer threshold with 400", async () => {
  const admin = userRepo.create({ username: "admin", email: "ad@example.com", password: "x", isAdmin: true });
  const res = await request(app({ userId: admin.id, isAdmin: true }))
    .put("/api/admin/retention")
    .send({ maxAgeDays: -1, maxTotalBytes: null, maxJobs: null });

  expect(res.status).toBe(400);
});

test("PUT /api/admin/retention is 403 for a non-admin", async () => {
  const nonAdmin = userRepo.create({ username: "a", email: "a@example.com", password: "x", isAdmin: false });
  const res = await request(app({ userId: nonAdmin.id, isAdmin: false }))
    .put("/api/admin/retention")
    .send({ maxAgeDays: 1, maxTotalBytes: null, maxJobs: null });
  expect(res.status).toBe(403);
});

// --- Upload limit -----------------------------------------------------------

const MB = 1024 * 1024;

function admin() {
  return userRepo.create({ username: "up-admin", email: "up@example.com", password: "x", isAdmin: true });
}

test("GET /api/admin/upload is 403 for a non-admin", async () => {
  const nonAdmin = userRepo.create({ username: "nu", email: "nu@example.com", password: "x", isAdmin: false });
  const res = await request(app({ userId: nonAdmin.id, isAdmin: false })).get("/api/admin/upload");
  expect(res.status).toBe(403);
});

test("PUT /api/admin/upload is 403 for a non-admin", async () => {
  const nonAdmin = userRepo.create({ username: "nu2", email: "nu2@example.com", password: "x", isAdmin: false });
  const res = await request(app({ userId: nonAdmin.id, isAdmin: false }))
    .put("/api/admin/upload")
    .send({ maxUploadBytes: 1024 });
  expect(res.status).toBe(403);
});

test("GET /api/admin/upload reports the default as effective when nothing is configured", async () => {
  const res = await request(app({ userId: admin().id, isAdmin: true })).get("/api/admin/upload");
  expect(res.status).toBe(200);
  expect(res.body).toEqual({
    maxUploadBytes: null,
    effectiveMaxUploadBytes: 512 * MB,
    defaultMaxUploadBytes: 512 * MB,
  });
});

test("PUT /api/admin/upload saves a limit and GET reflects it", async () => {
  const a = admin();
  const put = await request(app({ userId: a.id, isAdmin: true }))
    .put("/api/admin/upload")
    .send({ maxUploadBytes: 64 * MB });
  expect(put.status).toBe(200);
  expect(put.body.maxUploadBytes).toBe(64 * MB);
  expect(put.body.effectiveMaxUploadBytes).toBe(64 * MB);

  const get = await request(app({ userId: a.id, isAdmin: true })).get("/api/admin/upload");
  expect(get.body.maxUploadBytes).toBe(64 * MB);
});

test("PUT /api/admin/upload with null stores an explicit no-limit, distinct from unconfigured", async () => {
  const a = admin();
  const res = await request(app({ userId: a.id, isAdmin: true }))
    .put("/api/admin/upload")
    .send({ maxUploadBytes: null });
  expect(res.status).toBe(200);
  // Both fields null is what separates "admin chose unlimited" from the
  // unconfigured response above, where effective is the 512 MB default.
  expect(res.body.maxUploadBytes).toBeNull();
  expect(res.body.effectiveMaxUploadBytes).toBeNull();
});

test.each([[0], [-1], [1.5], ["512"], [true]])(
  "PUT /api/admin/upload rejects %p with 400",
  async (value) => {
    const res = await request(app({ userId: admin().id, isAdmin: true }))
      .put("/api/admin/upload")
      .send({ maxUploadBytes: value });
    expect(res.status).toBe(400);
    // 0 would mean "reject every upload" - a footgun, not a setting.
    expect(res.body.error).toMatch(/positive integer/);
  }
);

test("PUT /api/admin/upload with no maxUploadBytes key does not silently remove the limit", async () => {
  const a = admin();
  await request(app({ userId: a.id, isAdmin: true })).put("/api/admin/upload").send({ maxUploadBytes: 64 * MB });

  const res = await request(app({ userId: a.id, isAdmin: true })).put("/api/admin/upload").send({});

  // A malformed body must not be read as "the admin chose unlimited" - that
  // would disable the protection through a typo.
  expect(res.status).toBe(400);
  const after = await request(app({ userId: a.id, isAdmin: true })).get("/api/admin/upload");
  expect(after.body.effectiveMaxUploadBytes).toBe(64 * MB);
});

// --- Scheduler settings (concurrency) ----------------------------------------

test("scheduler settings default to no cap", async () => {
  const admin = userRepo.create({ username: "sched-admin", email: "sched@example.com", password: "x", isAdmin: true });
  const res = await request(app({ userId: admin.id, isAdmin: true })).get("/api/admin/scheduler");
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ maxConcurrentJobs: null });
});

test("an admin can set and clear the concurrency cap", async () => {
  const admin = userRepo.create({ username: "sched-admin", email: "sched@example.com", password: "x", isAdmin: true });
  await request(app({ userId: admin.id, isAdmin: true }))
    .put("/api/admin/scheduler")
    .send({ maxConcurrentJobs: 2 })
    .expect(200);
  expect((await request(app({ userId: admin.id, isAdmin: true })).get("/api/admin/scheduler")).body.maxConcurrentJobs).toBe(2);

  await request(app({ userId: admin.id, isAdmin: true }))
    .put("/api/admin/scheduler")
    .send({ maxConcurrentJobs: null })
    .expect(200);
  expect((await request(app({ userId: admin.id, isAdmin: true })).get("/api/admin/scheduler")).body.maxConcurrentJobs).toBeNull();
});

test("a body with no maxConcurrentJobs key is rejected, not read as null", async () => {
  // PUT /api/admin/upload with {} once silently disabled the upload cap
  // entirely - a whole-branch review finding in cycle 9. Absent and explicit
  // null must never be the same thing.
  const admin = userRepo.create({ username: "sched-admin2", email: "sched2@example.com", password: "x", isAdmin: true });
  const res = await request(app({ userId: admin.id, isAdmin: true }))
    .put("/api/admin/scheduler")
    .send({});
  expect(res.status).toBe(400);
});

test("a non-positive or non-integer cap is rejected", async () => {
  const admin = userRepo.create({ username: "sched-admin3", email: "sched3@example.com", password: "x", isAdmin: true });
  for (const value of [0, -1, 1.5, "2"]) {
    const res = await request(app({ userId: admin.id, isAdmin: true }))
      .put("/api/admin/scheduler")
      .send({ maxConcurrentJobs: value });
    expect(res.status).toBe(400);
  }
});

test("a non-admin cannot read or write scheduler settings", async () => {
  const nonAdmin = userRepo.create({ username: "sched-user", email: "user@example.com", password: "x", isAdmin: false });
  await request(app({ userId: nonAdmin.id, isAdmin: false })).get("/api/admin/scheduler").expect(403);
  await request(app({ userId: nonAdmin.id, isAdmin: false }))
    .put("/api/admin/scheduler")
    .send({ maxConcurrentJobs: 1 })
    .expect(403);
});
