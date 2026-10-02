import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import express from "express";
import { orgRoutes } from "../../src/api/orgs";
import { openDatabase, type Db } from "../../src/db/driver";
import { migrate } from "../../src/db/migrations";
import { UserRepository } from "../../src/store/userRepository";
import { OrgRepository } from "../../src/store/orgRepository";
import { OrgTokenRepository } from "../../src/store/orgTokenRepository";

const KEY = "0".repeat(64);

let dir: string;
let db: Db;
let userRepo: UserRepository;
let orgRepo: OrgRepository;
let tokenRepo: OrgTokenRepository;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-org-routes-"));
  db = openDatabase(path.join(dir, "farm.db"));
  migrate(db);
  userRepo = new UserRepository(db);
  orgRepo = new OrgRepository(db);
  tokenRepo = new OrgTokenRepository(db, KEY);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function app(userId?: number, isAdmin = false) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    if (userId !== undefined) req.userId = userId;
    req.isAdmin = isAdmin;
    next();
  });
  a.use(orgRoutes({ orgRepo, tokenRepo, userRepo }));
  return a;
}

test("a member can list their org's members", async () => {
  const member = userRepo.create({ username: "a", email: "a@example.com", password: "x", isAdmin: false });
  const org = orgRepo.create("donable", [member.id]);

  const res = await request(app(member.id)).get(`/api/orgs/${org.id}/members`);
  expect(res.status).toBe(200);
  expect(res.body.members).toHaveLength(1);
});

test("a non-member gets a 404 for an org they don't belong to (not a 403 - no confirmation the org exists)", async () => {
  const outsider = userRepo.create({ username: "outsider", email: "o@example.com", password: "x", isAdmin: false });
  const org = orgRepo.create("donable", []);

  const res = await request(app(outsider.id)).get(`/api/orgs/${org.id}/members`);
  expect(res.status).toBe(404);
});

test("an unauthenticated (no req.userId) request is a 401", async () => {
  const org = orgRepo.create("donable", []);
  const res = await request(app(undefined)).get(`/api/orgs/${org.id}/members`);
  expect(res.status).toBe(401);
});

test("a member can add an existing user to their org", async () => {
  const member = userRepo.create({ username: "a", email: "a@example.com", password: "x", isAdmin: false });
  const newcomer = userRepo.create({ username: "b", email: "b@example.com", password: "x", isAdmin: false });
  const org = orgRepo.create("donable", [member.id]);

  const res = await request(app(member.id)).post(`/api/orgs/${org.id}/members`).send({ userId: newcomer.id });
  expect(res.status).toBe(201);
  expect(orgRepo.isMember(newcomer.id, org.id)).toBe(true);
});

test("adding an unknown userId is a 404", async () => {
  const member = userRepo.create({ username: "a", email: "a@example.com", password: "x", isAdmin: false });
  const org = orgRepo.create("donable", [member.id]);

  const res = await request(app(member.id)).post(`/api/orgs/${org.id}/members`).send({ userId: 999999 });
  expect(res.status).toBe(404);
});

test("a member can remove another member", async () => {
  const a = userRepo.create({ username: "a", email: "a@example.com", password: "x", isAdmin: false });
  const b = userRepo.create({ username: "b", email: "b@example.com", password: "x", isAdmin: false });
  const org = orgRepo.create("donable", [a.id, b.id]);

  const res = await request(app(a.id)).delete(`/api/orgs/${org.id}/members/${b.id}`);
  expect(res.status).toBe(204);
  expect(orgRepo.isMember(b.id, org.id)).toBe(false);
});

test("a member can create a named token and gets the raw value back", async () => {
  const member = userRepo.create({ username: "a", email: "a@example.com", password: "x", isAdmin: false });
  const org = orgRepo.create("donable", [member.id]);

  const res = await request(app(member.id)).post(`/api/orgs/${org.id}/tokens`).send({ label: "CI" });
  expect(res.status).toBe(201);
  expect(res.body.token).toMatchObject({ label: "CI", orgId: org.id });
  expect(typeof res.body.token.value).toBe("string");
  expect(res.body.token.value.length).toBeGreaterThan(0);
});

test("creating a token with a missing label is a 400", async () => {
  const member = userRepo.create({ username: "a", email: "a@example.com", password: "x", isAdmin: false });
  const org = orgRepo.create("donable", [member.id]);
  const res = await request(app(member.id)).post(`/api/orgs/${org.id}/tokens`).send({});
  expect(res.status).toBe(400);
});

test("a member can list tokens with their decrypted values included", async () => {
  const member = userRepo.create({ username: "a", email: "a@example.com", password: "x", isAdmin: false });
  const org = orgRepo.create("donable", [member.id]);
  tokenRepo.create(org.id, "CI", "raw-value", member.id);

  const res = await request(app(member.id)).get(`/api/orgs/${org.id}/tokens`);
  expect(res.status).toBe(200);
  expect(res.body.tokens[0].value).toBe("raw-value");
});

// I5: this response carries every org token decrypted - never let a shared
// or browser cache hold onto it. Fails against the unfixed route, which
// sends no Cache-Control header.
test("marks the token-listing response no-store, since the body is plaintext tokens", async () => {
  const member = userRepo.create({ username: "a", email: "a@example.com", password: "x", isAdmin: false });
  const org = orgRepo.create("donable", [member.id]);
  tokenRepo.create(org.id, "CI", "raw-value", member.id);

  const res = await request(app(member.id)).get(`/api/orgs/${org.id}/tokens`);
  expect(res.headers["cache-control"]).toBe("no-store");
});

test("a member can revoke a token, scoped to their own org", async () => {
  const member = userRepo.create({ username: "a", email: "a@example.com", password: "x", isAdmin: false });
  const org = orgRepo.create("donable", [member.id]);
  const token = tokenRepo.create(org.id, "CI", "raw-value", member.id);

  const res = await request(app(member.id)).delete(`/api/orgs/${org.id}/tokens/${token.id}`);
  expect(res.status).toBe(204);
  expect(tokenRepo.list(org.id)).toEqual([]);
});

// I4: admin membership bypass
test("an admin who isn't a member of org X can still list org X's members", async () => {
  const admin = userRepo.create({ username: "admin", email: "ad@example.com", password: "x", isAdmin: true });
  const member = userRepo.create({ username: "a", email: "a@example.com", password: "x", isAdmin: false });
  const org = orgRepo.create("donable", [member.id]);

  const res = await request(app(admin.id, true)).get(`/api/orgs/${org.id}/members`);
  expect(res.status).toBe(200);
  expect(res.body.members).toHaveLength(1);
});

test("an admin who isn't a member of org X can add a member to org X", async () => {
  const admin = userRepo.create({ username: "admin", email: "ad@example.com", password: "x", isAdmin: true });
  const newcomer = userRepo.create({ username: "b", email: "b@example.com", password: "x", isAdmin: false });
  const org = orgRepo.create("donable", []);

  const res = await request(app(admin.id, true)).post(`/api/orgs/${org.id}/members`).send({ userId: newcomer.id });
  expect(res.status).toBe(201);
  expect(orgRepo.isMember(newcomer.id, org.id)).toBe(true);
});

test("an admin who isn't a member of org X can remove a member of org X", async () => {
  const admin = userRepo.create({ username: "admin", email: "ad@example.com", password: "x", isAdmin: true });
  const a = userRepo.create({ username: "a", email: "a@example.com", password: "x", isAdmin: false });
  const b = userRepo.create({ username: "b", email: "b@example.com", password: "x", isAdmin: false });
  const org = orgRepo.create("donable", [a.id, b.id]);

  const res = await request(app(admin.id, true)).delete(`/api/orgs/${org.id}/members/${b.id}`);
  expect(res.status).toBe(204);
  expect(orgRepo.isMember(b.id, org.id)).toBe(false);
});

test("a non-admin, non-member request from an admin flag-less user still 404s (sanity: bypass is isAdmin-gated)", async () => {
  const member = userRepo.create({ username: "a", email: "a@example.com", password: "x", isAdmin: false });
  const outsider = userRepo.create({ username: "outsider", email: "o@example.com", password: "x", isAdmin: false });
  const org = orgRepo.create("donable", [member.id]);

  const res = await request(app(outsider.id, false)).get(`/api/orgs/${org.id}/members`);
  expect(res.status).toBe(404);
});

test("an admin gets 404 for a genuinely nonexistent org id", async () => {
  const admin = userRepo.create({ username: "admin", email: "ad@example.com", password: "x", isAdmin: true });
  const res = await request(app(admin.id, true)).get("/api/orgs/999999/members");
  expect(res.status).toBe(404);
});

// I4: last-member guard
test("removing an org's last member is rejected", async () => {
  const onlyMember = userRepo.create({ username: "a", email: "a@example.com", password: "x", isAdmin: false });
  const org = orgRepo.create("donable", [onlyMember.id]);

  const res = await request(app(onlyMember.id)).delete(`/api/orgs/${org.id}/members/${onlyMember.id}`);
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(res.status).toBeLessThan(500);
  expect(orgRepo.isMember(onlyMember.id, org.id)).toBe(true);
});

// I8: archived orgs 404 for members on the member routes
test("a member of an archived org gets 404 from the member routes", async () => {
  const member = userRepo.create({ username: "a", email: "a@example.com", password: "x", isAdmin: false });
  const org = orgRepo.create("donable", [member.id]);
  orgRepo.archive(org.id);

  const res = await request(app(member.id)).get(`/api/orgs/${org.id}/members`);
  expect(res.status).toBe(404);
});

test("an admin can still inspect an archived org's membership (bypass is not blocked by archival)", async () => {
  const admin = userRepo.create({ username: "admin", email: "ad@example.com", password: "x", isAdmin: true });
  const member = userRepo.create({ username: "a", email: "a@example.com", password: "x", isAdmin: false });
  const org = orgRepo.create("donable", [member.id]);
  orgRepo.archive(org.id);

  const res = await request(app(admin.id, true)).get(`/api/orgs/${org.id}/members`);
  expect(res.status).toBe(200);
  expect(res.body.members).toHaveLength(1);
});
