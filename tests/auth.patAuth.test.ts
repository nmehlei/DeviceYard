import express from "express";
import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";
import { openDatabase } from "../src/db/driver";
import { migrate } from "../src/db/migrations";
import { UserRepository } from "../src/store/userRepository";
import { OrgRepository } from "../src/store/orgRepository";
import { OrgTokenRepository } from "../src/store/orgTokenRepository";
import { UserTokenRepository } from "../src/store/userTokenRepository";
import { attachPatUser, requireAuth } from "../src/auth";

const KEY = "0".repeat(64);

function makeApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pat-auth-"));
  const db = openDatabase(path.join(dir, "farm.db"));
  migrate(db);
  const users = new UserRepository(db);
  const orgs = new OrgRepository(db);
  const orgTokens = new OrgTokenRepository(db, KEY);
  const userTokens = new UserTokenRepository(db, KEY);

  const alice = users.create({ username: "alice", email: "a@example.com", password: "x", isAdmin: false });
  const donable = orgs.create("donable", [alice.id]);
  const nme = orgs.create("nme", [alice.id]);
  const foreign = orgs.create("foreign", []);
  const ciToken = orgTokens.generateAndCreate(donable.id, "ci", alice.id);
  const pat = userTokens.generateAndCreate(alice.id, "laptop");

  const app = express();
  app.use(attachPatUser(userTokens));
  app.use(requireAuth(orgTokens, orgs));
  app.get("/probe", (req, res) => {
    res.status(200).json({
      org: req.org ?? null,
      userId: req.userId ?? null,
      isAdmin: req.isAdmin ?? null,
      patUserId: req.patUserId ?? null,
    });
  });
  return { app, dir, orgs, alice, donable, nme, foreign, ciToken, pat };
}

/** Same as makeApp, but with a middleware ahead of attachPatUser that
 * simulates attachUserFromCookie having already populated req.userId /
 * req.isAdmin from a stale admin session cookie sitting alongside the PAT.
 * Without this, "userId stays unset" would pass whether or not requireAuth
 * actually strips the ambient identity - nothing else in this app ever sets
 * those fields in the first place. */
function makeAppWithStaleAdminCookie() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pat-auth-"));
  const db = openDatabase(path.join(dir, "farm.db"));
  migrate(db);
  const users = new UserRepository(db);
  const orgs = new OrgRepository(db);
  const orgTokens = new OrgTokenRepository(db, KEY);
  const userTokens = new UserTokenRepository(db, KEY);

  const alice = users.create({ username: "alice", email: "a@example.com", password: "x", isAdmin: false });
  const donable = orgs.create("donable", [alice.id]);
  const pat = userTokens.generateAndCreate(alice.id, "laptop");

  const app = express();
  app.use((req, _res, next) => {
    req.userId = 999;
    req.isAdmin = true;
    next();
  });
  app.use(attachPatUser(userTokens));
  app.use(requireAuth(orgTokens, orgs));
  app.get("/probe", (req, res) => {
    res.status(200).json({
      org: req.org ?? null,
      userId: req.userId ?? null,
      isAdmin: req.isAdmin ?? null,
      patUserId: req.patUserId ?? null,
    });
  });
  return { app, dir, alice, donable, pat };
}

describe("requireAuth with a PAT", () => {
  let ctx: ReturnType<typeof makeApp>;
  beforeEach(() => { ctx = makeApp(); });
  afterEach(() => fs.rmSync(ctx.dir, { recursive: true, force: true }));

  it("resolves the org named by X-Org-Id when the user is a member", async () => {
    const res = await request(ctx.app).get("/probe")
      .set("Authorization", `Bearer ${ctx.pat.value}`)
      .set("X-Org-Id", String(ctx.donable.id));
    expect(res.status).toBe(200);
    expect(res.body.org).toBe("donable");
  });

  it("lets the same PAT reach a second org - the whole point", async () => {
    const res = await request(ctx.app).get("/probe")
      .set("Authorization", `Bearer ${ctx.pat.value}`)
      .set("X-Org-Id", String(ctx.nme.id));
    expect(res.body.org).toBe("nme");
  });

  it("refuses an org the user does not belong to", async () => {
    const res = await request(ctx.app).get("/probe")
      .set("Authorization", `Bearer ${ctx.pat.value}`)
      .set("X-Org-Id", String(ctx.foreign.id));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "not a member of that org" });
  });

  it("refuses when no org is selected, rather than proceeding org-less", async () => {
    const res = await request(ctx.app).get("/probe").set("Authorization", `Bearer ${ctx.pat.value}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/org/i);
  });

  it("refuses an archived org", async () => {
    ctx.orgs.archive(ctx.nme.id);
    const res = await request(ctx.app).get("/probe")
      .set("Authorization", `Bearer ${ctx.pat.value}`)
      .set("X-Org-Id", String(ctx.nme.id));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "not a member of that org" });
  });

  it("never grants person-powers: userId stays unset", async () => {
    const res = await request(ctx.app).get("/probe")
      .set("Authorization", `Bearer ${ctx.pat.value}`)
      .set("X-Org-Id", String(ctx.donable.id));
    expect(res.body.userId).toBeNull();
    expect(res.body.patUserId).toBe(ctx.alice.id);
  });

  it("strips a stale admin cookie identity sitting alongside the PAT", async () => {
    const staleCtx = makeAppWithStaleAdminCookie();
    try {
      const res = await request(staleCtx.app).get("/probe")
        .set("Authorization", `Bearer ${staleCtx.pat.value}`)
        .set("X-Org-Id", String(staleCtx.donable.id));
      expect(res.body.org).toBe("donable");
      expect(res.body.userId).toBeNull();
      expect(res.body.isAdmin).toBeNull();
      expect(res.body.patUserId).toBe(staleCtx.alice.id);
    } finally {
      fs.rmSync(staleCtx.dir, { recursive: true, force: true });
    }
  });

  it("accepts ?orgId= as a fallback, like the cookie path does", async () => {
    const res = await request(ctx.app).get(`/probe?orgId=${ctx.donable.id}`)
      .set("Authorization", `Bearer ${ctx.pat.value}`);
    expect(res.body.org).toBe("donable");
  });
});

// Cheap item 4: findActiveByRawToken (src/store/userTokenRepository.ts) is
// what makes revocation and deactivation take effect immediately - both are
// currently only proven at the repository level (that the row disappears /
// the join excludes it). These are the auth-level proof that requireAuth
// actually 403s once that lookup comes back empty, rather than assuming the
// repository behaviour propagates correctly through attachPatUser's
// `if (found)` branch. Each fails against a requireAuth that (hypothetically)
// cached identity from the first successful call, or that treated "not
// found" as some status other than 403 "invalid token".
describe("requireAuth 403s a PAT that has stopped being valid", () => {
  it("403s once the token is revoked", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pat-auth-"));
    const db = openDatabase(path.join(dir, "farm.db"));
    migrate(db);
    const users = new UserRepository(db);
    const orgs = new OrgRepository(db);
    const orgTokens = new OrgTokenRepository(db, KEY);
    const userTokens = new UserTokenRepository(db, KEY);
    const alice = users.create({ username: "alice", email: "a@example.com", password: "x", isAdmin: false });
    const donable = orgs.create("donable", [alice.id]);
    const pat = userTokens.generateAndCreate(alice.id, "laptop");

    const app = express();
    app.use(attachPatUser(userTokens));
    app.use(requireAuth(orgTokens, orgs));
    app.get("/probe", (req, res) => res.status(200).json({ org: req.org ?? null }));

    try {
      const before = await request(app).get("/probe")
        .set("Authorization", `Bearer ${pat.value}`)
        .set("X-Org-Id", String(donable.id));
      expect(before.status).toBe(200);

      userTokens.revoke(pat.id, alice.id);

      const after = await request(app).get("/probe")
        .set("Authorization", `Bearer ${pat.value}`)
        .set("X-Org-Id", String(donable.id));
      expect(after.status).toBe(403);
      expect(after.body).toEqual({ error: "invalid token" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("403s once the token's user is deactivated", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pat-auth-"));
    const db = openDatabase(path.join(dir, "farm.db"));
    migrate(db);
    const users = new UserRepository(db);
    const orgs = new OrgRepository(db);
    const orgTokens = new OrgTokenRepository(db, KEY);
    const userTokens = new UserTokenRepository(db, KEY);
    const alice = users.create({ username: "alice", email: "a@example.com", password: "x", isAdmin: false });
    const donable = orgs.create("donable", [alice.id]);
    const pat = userTokens.generateAndCreate(alice.id, "laptop");

    const app = express();
    app.use(attachPatUser(userTokens));
    app.use(requireAuth(orgTokens, orgs));
    app.get("/probe", (req, res) => res.status(200).json({ org: req.org ?? null }));

    try {
      const before = await request(app).get("/probe")
        .set("Authorization", `Bearer ${pat.value}`)
        .set("X-Org-Id", String(donable.id));
      expect(before.status).toBe(200);

      users.deactivate(alice.id);

      const after = await request(app).get("/probe")
        .set("Authorization", `Bearer ${pat.value}`)
        .set("X-Org-Id", String(donable.id));
      expect(after.status).toBe(403);
      expect(after.body).toEqual({ error: "invalid token" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("requireAuth org-token path is unchanged", () => {
  let ctx: ReturnType<typeof makeApp>;
  beforeEach(() => { ctx = makeApp(); });
  afterEach(() => fs.rmSync(ctx.dir, { recursive: true, force: true }));

  it("still resolves the org from the token, ignoring X-Org-Id", async () => {
    const res = await request(ctx.app).get("/probe")
      .set("Authorization", `Bearer ${ctx.ciToken.value}`)
      .set("X-Org-Id", String(ctx.nme.id));
    expect(res.body.org).toBe("donable");
  });

  it("still 403s an unknown token", async () => {
    const res = await request(ctx.app).get("/probe").set("Authorization", "Bearer nope");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("invalid token");
  });
});
