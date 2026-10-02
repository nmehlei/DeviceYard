import fs from "fs";
import os from "os";
import path from "path";
import { openDatabase } from "../../src/db/driver";
import { migrate } from "../../src/db/migrations";
import { UserRepository } from "../../src/store/userRepository";
import { UserTokenRepository } from "../../src/store/userTokenRepository";

const KEY = "0".repeat(64);

function makeRepos() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pat-repo-"));
  const db = openDatabase(path.join(dir, "farm.db"));
  migrate(db);
  const users = new UserRepository(db);
  const alice = users.create({ username: "alice", email: "a@example.com", password: "x", isAdmin: false });
  const bob = users.create({ username: "bob", email: "b@example.com", password: "x", isAdmin: false });
  return { dir, db, users, alice, bob, tokens: new UserTokenRepository(db, KEY) };
}

describe("UserTokenRepository", () => {
  let ctx: ReturnType<typeof makeRepos>;
  beforeEach(() => { ctx = makeRepos(); });
  afterEach(() => fs.rmSync(ctx.dir, { recursive: true, force: true }));

  it("stores a token retrievably, like org tokens", () => {
    const created = ctx.tokens.generateAndCreate(ctx.alice.id, "laptop");
    expect(created.value).toHaveLength(32);
    const [listed] = ctx.tokens.list(ctx.alice.id);
    // Retrievable by design (spec D-6): the owner can read it back rather
    // than revoke and re-issue when setting up a second machine.
    expect(listed.value).toBe(created.value);
    expect(listed.label).toBe("laptop");
    expect(listed.lastUsedAt).toBeNull();
  });

  it("does not store the raw token in the database", () => {
    const created = ctx.tokens.generateAndCreate(ctx.alice.id, "laptop");
    const row = ctx.db.get<{ token_encrypted: string; token_hash: string }>(
      "SELECT token_encrypted, token_hash FROM user_tokens WHERE id = ?", created.id);
    expect(row!.token_encrypted).not.toContain(created.value);
    expect(row!.token_hash).not.toContain(created.value);
  });

  it("lists only the owner's tokens", () => {
    ctx.tokens.generateAndCreate(ctx.alice.id, "alice-laptop");
    ctx.tokens.generateAndCreate(ctx.bob.id, "bob-laptop");
    expect(ctx.tokens.list(ctx.alice.id).map((t) => t.label)).toEqual(["alice-laptop"]);
  });

  it("finds an active token by its raw value", () => {
    const created = ctx.tokens.generateAndCreate(ctx.alice.id, "laptop");
    expect(ctx.tokens.findActiveByRawToken(created.value)).toEqual({ id: created.id, userId: ctx.alice.id });
    expect(ctx.tokens.findActiveByRawToken("not-a-token")).toBeUndefined();
  });

  it("stops finding a deactivated user's token", () => {
    const created = ctx.tokens.generateAndCreate(ctx.alice.id, "laptop");
    ctx.users.deactivate(ctx.alice.id);
    expect(ctx.tokens.findActiveByRawToken(created.value)).toBeUndefined();
  });

  it("revokes only the owner's token, never another user's by guessed id", () => {
    const bobToken = ctx.tokens.generateAndCreate(ctx.bob.id, "bob-laptop");
    // Alice attempts to revoke Bob's token by its numeric id.
    ctx.tokens.revoke(bobToken.id, ctx.alice.id);
    expect(ctx.tokens.list(ctx.bob.id)).toHaveLength(1);
    ctx.tokens.revoke(bobToken.id, ctx.bob.id);
    expect(ctx.tokens.list(ctx.bob.id)).toHaveLength(0);
  });

  it("records when a token was last used", () => {
    const created = ctx.tokens.generateAndCreate(ctx.alice.id, "laptop");
    ctx.tokens.touchLastUsed(created.id);
    expect(ctx.tokens.list(ctx.alice.id)[0].lastUsedAt).not.toBeNull();
  });
});
