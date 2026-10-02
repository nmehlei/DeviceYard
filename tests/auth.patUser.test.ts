import express from "express";
import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";
import { openDatabase } from "../src/db/driver";
import { migrate } from "../src/db/migrations";
import { UserRepository } from "../src/store/userRepository";
import { UserTokenRepository } from "../src/store/userTokenRepository";
import { attachPatUser } from "../src/auth";

const KEY = "0".repeat(64);

function makeApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pat-mw-"));
  const db = openDatabase(path.join(dir, "farm.db"));
  migrate(db);
  const users = new UserRepository(db);
  const alice = users.create({ username: "alice", email: "a@example.com", password: "x", isAdmin: false });
  const tokens = new UserTokenRepository(db, KEY);
  const pat = tokens.generateAndCreate(alice.id, "laptop");

  const app = express();
  app.use(attachPatUser(tokens));
  app.get("/probe", (req, res) => {
    res.status(200).json({ patUserId: req.patUserId ?? null, userId: req.userId ?? null });
  });
  return { app, dir, alice, pat, tokens };
}

describe("attachPatUser", () => {
  it("attaches the owner for a valid PAT", async () => {
    const { app, alice, pat, dir } = makeApp();
    const res = await request(app).get("/probe").set("Authorization", `Bearer ${pat.value}`);
    expect(res.body.patUserId).toBe(alice.id);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("attaches nobody for an unknown token, and does not block", async () => {
    const { app, dir } = makeApp();
    const res = await request(app).get("/probe").set("Authorization", "Bearer nope");
    expect(res.status).toBe(200);
    expect(res.body.patUserId).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("never sets userId - a PAT is not a session", async () => {
    const { app, pat, dir } = makeApp();
    const res = await request(app).get("/probe").set("Authorization", `Bearer ${pat.value}`);
    expect(res.body.userId).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("records last use", async () => {
    const { app, pat, tokens, alice, dir } = makeApp();
    await request(app).get("/probe").set("Authorization", `Bearer ${pat.value}`);
    expect(tokens.list(alice.id)[0].lastUsedAt).not.toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
