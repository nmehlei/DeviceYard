import express from "express";
import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";
import { openDatabase } from "../../src/db/driver";
import { migrate } from "../../src/db/migrations";
import { UserRepository } from "../../src/store/userRepository";
import { OrgRepository } from "../../src/store/orgRepository";
import { UserTokenRepository } from "../../src/store/userTokenRepository";
import { meRoutes } from "../../src/api/me";

const KEY = "0".repeat(64);

/** `as` picks which identity the fake auth layer attaches, so each test can
 * say plainly whether it is acting as a session or as a PAT. */
function makeApp(as: "session" | "pat" | "anonymous") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pat-me-"));
  const db = openDatabase(path.join(dir, "farm.db"));
  migrate(db);
  const users = new UserRepository(db);
  const orgs = new OrgRepository(db);
  const userTokens = new UserTokenRepository(db, KEY);
  const alice = users.create({ username: "alice", email: "a@example.com", password: "x", isAdmin: false });
  const donable = orgs.create("donable", [alice.id]);
  const nme = orgs.create("nme", [alice.id]);
  orgs.create("foreign", []);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (as === "session") req.userId = alice.id;
    if (as === "pat") req.patUserId = alice.id;
    next();
  });
  app.use(meRoutes({ orgRepo: orgs, userTokenRepo: userTokens }));
  return { app, dir, alice, donable, nme, userTokens };
}

describe("GET /api/me/orgs", () => {
  it("lists the caller's orgs for a session", async () => {
    const { app, dir } = makeApp("session");
    const res = await request(app).get("/api/me/orgs");
    expect(res.status).toBe(200);
    expect(res.body.orgs.map((o: { name: string }) => o.name).sort()).toEqual(["donable", "nme"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("lists them for a PAT too - this is the discovery call", async () => {
    const { app, dir } = makeApp("pat");
    const res = await request(app).get("/api/me/orgs");
    expect(res.status).toBe(200);
    expect(res.body.orgs).toHaveLength(2);
    expect(res.body.orgs[0]).toHaveProperty("id");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("401s for nobody", async () => {
    const { app, dir } = makeApp("anonymous");
    expect((await request(app).get("/api/me/orgs")).status).toBe(401);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("/api/me/tokens is session-only", () => {
  it("lists the caller's tokens for a session", async () => {
    const { app, alice, userTokens, dir } = makeApp("session");
    userTokens.generateAndCreate(alice.id, "laptop");
    const res = await request(app).get("/api/me/tokens");
    expect(res.status).toBe(200);
    expect(res.body.tokens[0].label).toBe("laptop");
    expect(res.body.tokens[0].value).toBeDefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates a token with a label", async () => {
    const { app, dir } = makeApp("session");
    const res = await request(app).post("/api/me/tokens").send({ label: "desktop" });
    expect(res.status).toBe(201);
    expect(res.body.token.value).toBeDefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // I5: this response carries every PAT decrypted - a shared or browser
  // cache holding onto it would be as bad as fetching it too often. Fails
  // against the unfixed route, which sends no Cache-Control header at all.
  it("marks GET responses no-store, since the body is plaintext tokens", async () => {
    const { app, alice, userTokens, dir } = makeApp("session");
    userTokens.generateAndCreate(alice.id, "laptop");
    const res = await request(app).get("/api/me/tokens");
    expect(res.headers["cache-control"]).toBe("no-store");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("marks the create response no-store too", async () => {
    const { app, dir } = makeApp("session");
    const res = await request(app).post("/api/me/tokens").send({ label: "desktop" });
    expect(res.headers["cache-control"]).toBe("no-store");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a blank label", async () => {
    const { app, dir } = makeApp("session");
    expect((await request(app).post("/api/me/tokens").send({ label: "  " })).status).toBe(400);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("revokes", async () => {
    const { app, alice, userTokens, dir } = makeApp("session");
    const t = userTokens.generateAndCreate(alice.id, "laptop");
    expect((await request(app).delete(`/api/me/tokens/${t.id}`)).status).toBe(204);
    expect(userTokens.list(alice.id)).toHaveLength(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // The containment property: a leaked PAT must not be able to mint its
  // successor and survive being revoked.
  it.each(["get", "post", "delete"] as const)("refuses %s from a PAT", async (method) => {
    const { app, alice, userTokens, dir } = makeApp("pat");
    const t = userTokens.generateAndCreate(alice.id, "laptop");
    const res = method === "get" ? await request(app).get("/api/me/tokens")
      : method === "post" ? await request(app).post("/api/me/tokens").send({ label: "x" })
      : await request(app).delete(`/api/me/tokens/${t.id}`);
    expect(res.status).toBe(401);
    expect(userTokens.list(alice.id)).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
