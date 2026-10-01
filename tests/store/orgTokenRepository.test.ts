import fs from "fs";
import os from "os";
import path from "path";
import { openDatabase, type Db } from "../../src/db/driver";
import { migrate } from "../../src/db/migrations";
import { OrgRepository } from "../../src/store/orgRepository";
import { OrgTokenRepository } from "../../src/store/orgTokenRepository";

const KEY = "0".repeat(64);

let dir: string;
let db: Db;
let orgs: OrgRepository;
let tokens: OrgTokenRepository;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-org-token-repo-"));
  db = openDatabase(path.join(dir, "farm.db"));
  migrate(db);
  orgs = new OrgRepository(db);
  tokens = new OrgTokenRepository(db, KEY);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("create stores an org token and list returns it decrypted", () => {
  const org = orgs.create("donable", []);
  const created = tokens.create(org.id, "CI", "raw-token-value", null);
  expect(created.value).toBe("raw-token-value");

  const listed = tokens.list(org.id);
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({ label: "CI", value: "raw-token-value", orgId: org.id });
});

test("the raw token is never stored in plaintext in the database", () => {
  const org = orgs.create("donable", []);
  tokens.create(org.id, "CI", "raw-token-value", null);
  const row = db.get<{ token_encrypted: string }>("SELECT token_encrypted FROM org_tokens WHERE org_id = ?", org.id);
  expect(row?.token_encrypted).toBeDefined();
  expect(row?.token_encrypted).not.toContain("raw-token-value");
});

test("generateAndCreate produces a token findActiveOrgNameByRawToken can find", () => {
  const org = orgs.create("donable", []);
  const created = tokens.generateAndCreate(org.id, "CI", null);
  expect(tokens.findActiveOrgNameByRawToken(created.value)).toBe("donable");
});

test("findActiveOrgNameByRawToken returns undefined for an unknown token", () => {
  expect(tokens.findActiveOrgNameByRawToken("never-issued")).toBeUndefined();
});

test("findActiveOrgNameByRawToken returns undefined once the org is archived", () => {
  const org = orgs.create("donable", []);
  const created = tokens.generateAndCreate(org.id, "CI", null);
  orgs.archive(org.id);
  expect(tokens.findActiveOrgNameByRawToken(created.value)).toBeUndefined();
});

test("revoke removes a token scoped to its own org, and list stops returning it", () => {
  const org = orgs.create("donable", []);
  const created = tokens.create(org.id, "CI", "raw-token-value", null);
  tokens.revoke(created.id, org.id);
  expect(tokens.list(org.id)).toEqual([]);
});

test("revoke is a no-op for a token id that belongs to a different org", () => {
  const orgA = orgs.create("donable", []);
  const orgB = orgs.create("acme", []);
  const created = tokens.create(orgA.id, "CI", "raw-token-value", null);
  tokens.revoke(created.id, orgB.id);
  expect(tokens.list(orgA.id)).toHaveLength(1);
});

test("seedIfEmpty creates one token per TOKENS_JSON entry, only when org_tokens is empty", () => {
  const org = orgs.create("donable", []);
  tokens.seedIfEmpty({ donable: "legacy-token-value" }, (name) => orgs.getByName(name)?.id);
  expect(tokens.findActiveOrgNameByRawToken("legacy-token-value")).toBe("donable");

  // a second call, even with different data, must not add a duplicate
  tokens.seedIfEmpty({ donable: "another-value" }, (name) => orgs.getByName(name)?.id);
  expect(tokens.list(org.id)).toHaveLength(1);
});

test("multiple named tokens can coexist on the same org", () => {
  const org = orgs.create("donable", []);
  tokens.create(org.id, "CI", "token-a", null);
  tokens.create(org.id, "local testing", "token-b", null);
  expect(tokens.list(org.id).map((t) => t.label).sort()).toEqual(["CI", "local testing"]);
});
