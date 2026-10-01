// Proves the wiring end to end against the real createServer: one PAT
// reaching two orgs' job lists, and never reaching admin routes.
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { createServer } from "../../src/server";
import { openDatabase } from "../../src/db/driver";
import { migrate } from "../../src/db/migrations";
import { JobRepository } from "../../src/store/jobRepository";
import { DeviceRepository } from "../../src/store/deviceRepository";
import { UserRepository } from "../../src/store/userRepository";
import { OrgRepository } from "../../src/store/orgRepository";
import { OrgTokenRepository } from "../../src/store/orgTokenRepository";
import { UserTokenRepository } from "../../src/store/userTokenRepository";

const KEY = "0".repeat(64);

function makeServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pat-int-"));
  const db = openDatabase(path.join(dataDir, "farm.db"));
  migrate(db);
  const deviceRepo = new DeviceRepository(db);
  deviceRepo.seedIfEmpty("emulator-5554");
  const userRepo = new UserRepository(db);
  const orgRepo = new OrgRepository(db);
  const orgTokenRepo = new OrgTokenRepository(db, KEY);
  const userTokenRepo = new UserTokenRepository(db, KEY);

  const alice = userRepo.create({ username: "alice", email: "a@example.com", password: "x", isAdmin: false });
  const donable = orgRepo.create("donable", [alice.id]);
  const nme = orgRepo.create("nme", [alice.id]);
  const pat = userTokenRepo.generateAndCreate(alice.id, "laptop");

  const app = createServer({
    repo: new JobRepository(db), deviceRepo, userRepo, orgRepo, orgTokenRepo, userTokenRepo,
    dataDir, uploadDir: path.join(dataDir, "uploads"),
    sessionSecret: "x".repeat(32), deviceId: "emulator-5554",
  });
  return { app, dataDir, pat, donable, nme };
}

describe("a PAT against the real server", () => {
  it("reaches both orgs' job lists with one credential", async () => {
    const { app, dataDir, pat, donable, nme } = makeServer();
    for (const org of [donable, nme]) {
      const res = await request(app).get("/api/jobs")
        .set("Authorization", `Bearer ${pat.value}`)
        .set("X-Org-Id", String(org.id));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.jobs)).toBe(true);
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("discovers its orgs without naming one", async () => {
    const { app, dataDir, pat } = makeServer();
    const res = await request(app).get("/api/me/orgs").set("Authorization", `Bearer ${pat.value}`);
    expect(res.status).toBe(200);
    expect(res.body.orgs.map((o: { name: string }) => o.name).sort()).toEqual(["donable", "nme"]);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("cannot reach admin routes", async () => {
    const { app, dataDir, pat, donable } = makeServer();

    // First prove the token actually authenticates against this org - a
    // status merely "in the 401-499 range" from the admin route below
    // cannot tell "the PAT authenticated and was correctly denied" apart
    // from "the PAT never authenticated at all" (requireAuth's generic
    // "invalid token" 403 is inside that same range). This call fails loudly
    // if attachPatUser stops running before requireAuth.
    const authenticated = await request(app).get("/api/jobs")
      .set("Authorization", `Bearer ${pat.value}`)
      .set("X-Org-Id", String(donable.id));
    expect(authenticated.status).toBe(200);

    const res = await request(app).get("/api/admin/orgs")
      .set("Authorization", `Bearer ${pat.value}`)
      .set("X-Org-Id", String(donable.id));
    // Must be the admin check's specific denial, not requireAuth's generic
    // "invalid token" rejection - those share the 403 status, so the body
    // is what actually distinguishes "authenticated then correctly denied"
    // from "never authenticated".
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "admin access required" });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("cannot create another token for itself", async () => {
    const { app, dataDir, pat } = makeServer();
    const res = await request(app).post("/api/me/tokens")
      .set("Authorization", `Bearer ${pat.value}`)
      .send({ label: "successor" });
    expect(res.status).toBe(401);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // Cheap item 3: the spec's Testing section requires a PAT-authenticated
  // /api/orgs/* WRITE to fail, same as /api/admin/* above - only the admin
  // half existed. /api/orgs/:id/members' requireMember gate checks
  // `req.userId`, which a PAT never sets (only req.patUserId), so this must
  // 401 regardless of membership or X-Org-Id.
  it("cannot write to /api/orgs/*, even for an org it belongs to", async () => {
    const { app, dataDir, pat, donable } = makeServer();

    const authenticated = await request(app).get("/api/jobs")
      .set("Authorization", `Bearer ${pat.value}`)
      .set("X-Org-Id", String(donable.id));
    expect(authenticated.status).toBe(200);

    const res = await request(app).post(`/api/orgs/${donable.id}/members`)
      .set("Authorization", `Bearer ${pat.value}`)
      .set("X-Org-Id", String(donable.id))
      .send({ userId: 1 });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "login required" });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});
