import fs from "fs";
import os from "os";
import path from "path";
import express from "express";
import request from "supertest";
import { mcpClientRoutes } from "../../src/api/mcpClient";
import { createServer } from "../../src/server";
import { openDatabase } from "../../src/db/driver";
import { migrate } from "../../src/db/migrations";
import { JobRepository } from "../../src/store/jobRepository";
import { DeviceRepository } from "../../src/store/deviceRepository";
import { UserRepository } from "../../src/store/userRepository";
import { OrgRepository } from "../../src/store/orgRepository";
import { OrgTokenRepository } from "../../src/store/orgTokenRepository";
import { UserTokenRepository } from "../../src/store/userTokenRepository";

let dir: string;
let bundlePath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-route-"));
  bundlePath = path.join(dir, "mcp.mjs");
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function app() {
  const a = express();
  a.use(mcpClientRoutes({ bundlePath }));
  return a;
}

describe("GET /api/mcp-client", () => {
  it("serves the bundle as javascript, uncached", async () => {
    fs.writeFileSync(bundlePath, "console.log('hi')");
    const res = await request(app()).get("/api/mcp-client");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("javascript");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.text).toContain("console.log");
  });

  it("returns a clear 503, not a stack trace, when the bundle is missing", async () => {
    const res = await request(app()).get("/api/mcp-client");
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not available/i);
  });
});

/** The tests above mount the bare router, which by construction cannot see
 * whether it sits behind the `auth` guard - and "the bundle is gated by the
 * org token" is the whole premise of decision D-5. This one goes through the
 * real createServer() so a refactor that mounts the route before `auth`
 * fails here instead of quietly publishing the client to the internet.
 * Harness setup follows tests/server.test.ts. */
describe("GET /api/mcp-client through the real server", () => {
  const TOKEN = "donable-token-123";
  const TOKEN_ENCRYPTION_KEY = "0".repeat(64);
  let dataDir: string;
  let uploadDir: string;
  let app: express.Express;

  beforeAll(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-route-server-data-"));
    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-route-server-upload-"));
    const db = openDatabase(path.join(dataDir, "farm.db"));
    migrate(db);
    const deviceRepo = new DeviceRepository(db);
    deviceRepo.seedIfEmpty("emulator-5554");
    const userRepo = new UserRepository(db);
    const orgRepo = new OrgRepository(db);
    const orgTokenRepo = new OrgTokenRepository(db, TOKEN_ENCRYPTION_KEY);
    const userTokenRepo = new UserTokenRepository(db, TOKEN_ENCRYPTION_KEY);
    const admin = userRepo.create({ username: "admin", email: "admin@example.com", password: "x", isAdmin: true });
    const org = orgRepo.create("donable", [admin.id]);
    orgTokenRepo.create(org.id, "test", TOKEN, admin.id);

    app = createServer({
      userRepo,
      orgRepo,
      orgTokenRepo,
      userTokenRepo,
      sessionSecret: "test-session-secret-that-is-long-enough",
      deviceId: "emulator-5554",
      deviceRepo,
      runner: async () => ({ code: 0, stdout: "", stderr: "" }),
      uploadDir,
      repo: new JobRepository(db),
      dataDir,
    });
  });

  afterAll(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(uploadDir, { recursive: true, force: true });
  });

  it("rejects an unauthenticated request", async () => {
    const res = await request(app).get("/api/mcp-client");
    expect(res.status).toBe(401);
    expect(res.text).not.toContain(TOKEN);
  });

  it("rejects a wrong token", async () => {
    // 403 rather than 401 here: the guard distinguishes "no credential" from
    // "a credential that is not ours" (see src/auth.ts).
    const res = await request(app).get("/api/mcp-client").set("Authorization", "Bearer nope");
    expect(res.status).toBe(403);
  });

  it("gets past auth with a valid org token", async () => {
    const res = await request(app).get("/api/mcp-client").set("Authorization", `Bearer ${TOKEN}`);
    // The bundle itself is not built in a test tree, so 503 is the correct
    // authenticated answer here. What matters is that it is not a 401.
    expect(res.status).not.toBe(401);
    expect([200, 503]).toContain(res.status);
  });
});
