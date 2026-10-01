import fs from "fs";
import os from "os";
import path from "path";
import { openDatabase, type Db } from "../../src/db/driver";
import { migrate } from "../../src/db/migrations";
import { OrgRepository } from "../../src/store/orgRepository";
import { UserRepository } from "../../src/store/userRepository";

let dir: string;
let db: Db;
let repo: OrgRepository;
let users: UserRepository;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-org-repo-"));
  db = openDatabase(path.join(dir, "farm.db"));
  migrate(db);
  repo = new OrgRepository(db);
  users = new UserRepository(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("seedIfEmpty inserts one org per name and adds the given user as a member", () => {
  const admin = users.create({ username: "admin", email: "a@example.com", password: "x", isAdmin: true });
  repo.seedIfEmpty(["donable", "acme"], admin.id);

  const orgs = repo.list();
  expect(orgs.map((o) => o.name).sort()).toEqual(["acme", "donable"]);
  expect(orgs.every((o) => o.archivedAt === null)).toBe(true);
  expect(repo.listForUser(admin.id).map((o) => o.name).sort()).toEqual(["acme", "donable"]);
});

test("seedIfEmpty is a no-op once the table has any row", () => {
  const admin = users.create({ username: "admin", email: "a@example.com", password: "x", isAdmin: true });
  repo.create("existing-org", [admin.id]);
  repo.seedIfEmpty(["donable"], admin.id);
  expect(repo.list().map((o) => o.name)).toEqual(["existing-org"]);
});

test("create adds the given initial members", () => {
  const a = users.create({ username: "a", email: "a@example.com", password: "x", isAdmin: false });
  const b = users.create({ username: "b", email: "b@example.com", password: "x", isAdmin: false });
  const org = repo.create("donable", [a.id, b.id]);

  expect(repo.isMember(a.id, org.id)).toBe(true);
  expect(repo.isMember(b.id, org.id)).toBe(true);
  expect(repo.listMembers(org.id).map((u) => u.username).sort()).toEqual(["a", "b"]);
});

test("getByName finds an org case-sensitively by its exact name", () => {
  const org = repo.create("donable", []);
  expect(repo.getByName("donable")).toEqual(org);
  expect(repo.getByName("Donable")).toBeUndefined();
});

test("rename changes the name in place", () => {
  const org = repo.create("old-name", []);
  repo.rename(org.id, "new-name");
  expect(repo.getById(org.id)?.name).toBe("new-name");
});

test("archive sets archivedAt and removes the org from listForUser", () => {
  const a = users.create({ username: "a", email: "a@example.com", password: "x", isAdmin: false });
  const org = repo.create("donable", [a.id]);
  repo.archive(org.id);

  expect(repo.getById(org.id)?.archivedAt).not.toBeNull();
  expect(repo.listForUser(a.id)).toEqual([]);
  // list() (admin-facing) still shows the archived org - only the
  // member-facing listForUser hides it.
  expect(repo.list().map((o) => o.id)).toContain(org.id);
});

test("addMember and removeMember change membership and isMember", () => {
  const a = users.create({ username: "a", email: "a@example.com", password: "x", isAdmin: false });
  const org = repo.create("donable", []);
  expect(repo.isMember(a.id, org.id)).toBe(false);

  repo.addMember(org.id, a.id);
  expect(repo.isMember(a.id, org.id)).toBe(true);

  repo.removeMember(org.id, a.id);
  expect(repo.isMember(a.id, org.id)).toBe(false);
});

test("addMember is idempotent - adding an existing member again does not throw", () => {
  const a = users.create({ username: "a", email: "a@example.com", password: "x", isAdmin: false });
  const org = repo.create("donable", [a.id]);
  expect(() => repo.addMember(org.id, a.id)).not.toThrow();
  expect(repo.listMembers(org.id)).toHaveLength(1);
});

test("isMember is false for an unknown org or user", () => {
  const a = users.create({ username: "a", email: "a@example.com", password: "x", isAdmin: false });
  const org = repo.create("donable", []);
  expect(repo.isMember(a.id, 999999)).toBe(false);
  expect(repo.isMember(999999, org.id)).toBe(false);
});
