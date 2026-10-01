import fs from "fs";
import os from "os";
import path from "path";
import { openDatabase, type Db } from "../../src/db/driver";
import { migrate } from "../../src/db/migrations";
import { UserRepository } from "../../src/store/userRepository";

let dir: string;
let db: Db;
let repo: UserRepository;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-user-repo-"));
  db = openDatabase(path.join(dir, "farm.db"));
  migrate(db);
  repo = new UserRepository(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("seedIfEmpty inserts one admin when the table is empty", () => {
  repo.seedIfEmpty("admin", "admin@example.com", "bootstrap-password");
  const users = repo.list();
  expect(users).toHaveLength(1);
  expect(users[0]).toMatchObject({ username: "admin", email: "admin@example.com", isAdmin: true, deactivatedAt: null });
});

test("seedIfEmpty is a no-op once the table has any row", () => {
  repo.create({ username: "existing", email: "e@example.com", password: "x", isAdmin: false });
  repo.seedIfEmpty("admin", "admin@example.com", "bootstrap-password");
  expect(repo.list()).toHaveLength(1);
  expect(repo.list()[0].username).toBe("existing");
});

test("create stores a password hash, never the raw password", () => {
  const user = repo.create({ username: "nicolas", email: "n@example.com", password: "hunter2", isAdmin: false });
  const raw = db.get<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", user.id);
  expect(raw?.password_hash).toBeDefined();
  expect(raw?.password_hash).not.toContain("hunter2");
});

test("getByUsername and getById return the same row", () => {
  const created = repo.create({ username: "priya", email: "p@example.com", password: "x", isAdmin: false });
  expect(repo.getByUsername("priya")).toEqual(created);
  expect(repo.getById(created.id)).toEqual(created);
});

test("getByUsername returns undefined for an unknown username", () => {
  expect(repo.getByUsername("nobody")).toBeUndefined();
});

test("verifyCredentials returns the user on a correct password", () => {
  const created = repo.create({ username: "priya", email: "p@example.com", password: "correct-password", isAdmin: false });
  expect(repo.verifyCredentials("priya", "correct-password")).toEqual(created);
});

test("verifyCredentials returns undefined on a wrong password", () => {
  repo.create({ username: "priya", email: "p@example.com", password: "correct-password", isAdmin: false });
  expect(repo.verifyCredentials("priya", "wrong-password")).toBeUndefined();
});

test("verifyCredentials returns undefined for a deactivated user even with the right password", () => {
  const user = repo.create({ username: "priya", email: "p@example.com", password: "correct-password", isAdmin: false });
  repo.deactivate(user.id);
  expect(repo.verifyCredentials("priya", "correct-password")).toBeUndefined();
});

test("setAdmin toggles the is_admin flag", () => {
  const user = repo.create({ username: "priya", email: "p@example.com", password: "x", isAdmin: false });
  repo.setAdmin(user.id, true);
  expect(repo.getById(user.id)?.isAdmin).toBe(true);
  repo.setAdmin(user.id, false);
  expect(repo.getById(user.id)?.isAdmin).toBe(false);
});

test("setPassword changes what verifyCredentials accepts", () => {
  const user = repo.create({ username: "priya", email: "p@example.com", password: "old-password", isAdmin: false });
  repo.setPassword(user.id, "new-password");
  expect(repo.verifyCredentials("priya", "old-password")).toBeUndefined();
  expect(repo.verifyCredentials("priya", "new-password")).toEqual(repo.getById(user.id));
});

test("deactivate sets deactivatedAt without deleting the row", () => {
  const user = repo.create({ username: "priya", email: "p@example.com", password: "x", isAdmin: false });
  repo.deactivate(user.id);
  const after = repo.getById(user.id);
  expect(after).toBeDefined();
  expect(after?.deactivatedAt).not.toBeNull();
});
