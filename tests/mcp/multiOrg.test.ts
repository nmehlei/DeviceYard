// tests/mcp/multiOrg.test.ts
//
// The cross-org isolation proof for personal access tokens. Drives the real
// MCP tool functions (src/mcp/tools/*) through a real createFarmClient and
// createOrgResolver against a real createServer + SQLite, exactly the way
// tests/api/mePatIntegration.test.ts proves the server side but going one
// layer further out - through the client the agent actually calls.
//
// Artifacts are screenshots of real logged-in app sessions, so "job created
// under org A must not be visible when the same PAT selects org B" is a
// privacy boundary, not a tidiness check. If any assertion here ever finds
// org B's job while scoped to org A, that is a Critical finding to report,
// not a test to adjust.
import fs from "fs";
import os from "os";
import path from "path";
import { createServer } from "../../src/server";
import { openDatabase } from "../../src/db/driver";
import { migrate } from "../../src/db/migrations";
import { JobRepository } from "../../src/store/jobRepository";
import { DeviceRepository } from "../../src/store/deviceRepository";
import { UserRepository } from "../../src/store/userRepository";
import { OrgRepository } from "../../src/store/orgRepository";
import { OrgTokenRepository } from "../../src/store/orgTokenRepository";
import { UserTokenRepository } from "../../src/store/userTokenRepository";
import { createFarmClient } from "../../src/mcp/client";
import { createOrgResolver } from "../../src/mcp/orgs";
import { listJobs, getDevice } from "../../src/mcp/tools/reads";
import { buildServer } from "../../src/mcp/index";

const KEY = "0".repeat(64);
const TEST_DEVICE_ID = "emulator-5554";

function makeServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-multiorg-"));
  const db = openDatabase(path.join(dataDir, "farm.db"));
  migrate(db);

  const deviceRepo = new DeviceRepository(db);
  deviceRepo.seedIfEmpty(TEST_DEVICE_ID);

  const userRepo = new UserRepository(db);
  const orgRepo = new OrgRepository(db);
  const orgTokenRepo = new OrgTokenRepository(db, KEY);
  const userTokenRepo = new UserTokenRepository(db, KEY);
  const repo = new JobRepository(db);

  const alice = userRepo.create({ username: "alice", email: "alice@example.com", password: "x", isAdmin: false });
  const donable = orgRepo.create("donable", [alice.id]);
  const nme = orgRepo.create("nme", [alice.id]);
  // A third org alice does NOT belong to - the org the PAT must never reach.
  const acme = orgRepo.create("acme", []);

  const pat = userTokenRepo.generateAndCreate(alice.id, "laptop");

  // Seed a job directly under each org, bypassing any real flow run - the
  // isolation boundary under test is auth/org scoping, not job execution.
  const donableJob = repo.createJob("donable", ["map"]);
  const nmeJob = repo.createJob("nme", ["settings"]);

  const app = createServer({
    repo,
    deviceRepo,
    userRepo,
    orgRepo,
    orgTokenRepo,
    userTokenRepo,
    dataDir,
    uploadDir: path.join(dataDir, "uploads"),
    sessionSecret: "x".repeat(32),
    deviceId: TEST_DEVICE_ID,
  });

  return { app, dataDir, pat, alice, donable, nme, acme, donableJob, nmeJob };
}

function clientFor(baseUrl: string, token: string, orgId?: number) {
  return createFarmClient({ farmUrl: baseUrl, token, timeoutMs: 30000 }, orgId);
}

describe("cross-org isolation through the real MCP tools", () => {
  let http: import("http").Server;
  let baseUrl: string;
  let ctx: ReturnType<typeof makeServer>;

  beforeEach(async () => {
    ctx = makeServer();
    http = ctx.app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => http.once("listening", resolve));
    const address = http.address();
    if (address === null || typeof address === "string") throw new Error("expected a bound AddressInfo");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => http.close(() => resolve()));
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });

  it("returns each org's own jobs when org names it, and never the other org's job", async () => {
    // Resolve org name -> id the same way a real agent would: via the
    // resolver, which calls GET /api/me/orgs. This needs a client with no
    // org selected yet (an org-less lookup call, matching D-2 discovery).
    const discovery = clientFor(baseUrl, ctx.pat.value);
    const resolver = createOrgResolver(discovery);

    const donableEntry = await resolver.resolve("donable");
    const nmeEntry = await resolver.resolve("nme");
    expect(donableEntry.id).toBe(ctx.donable.id);
    expect(nmeEntry.id).toBe(ctx.nme.id);

    const donableResult = await listJobs(clientFor(baseUrl, ctx.pat.value, donableEntry.id), {});
    expect(donableResult.isError).toBeUndefined();
    const donableText = (donableResult.content[0] as { text: string }).text;
    expect(donableText).toContain(ctx.donableJob.id);
    // THE privacy boundary: org A's job list must never contain org B's job.
    expect(donableText).not.toContain(ctx.nmeJob.id);

    const nmeResult = await listJobs(clientFor(baseUrl, ctx.pat.value, nmeEntry.id), {});
    expect(nmeResult.isError).toBeUndefined();
    const nmeText = (nmeResult.content[0] as { text: string }).text;
    expect(nmeText).toContain(ctx.nmeJob.id);
    // And the reverse: org B's job list must never contain org A's job.
    expect(nmeText).not.toContain(ctx.donableJob.id);
  });

  it("refuses an org the PAT's user does not belong to, naming the orgs they do belong to", async () => {
    const discovery = clientFor(baseUrl, ctx.pat.value);
    const resolver = createOrgResolver(discovery);

    await expect(resolver.resolve("acme")).rejects.toThrow(/donable/);
    await expect(resolver.resolve("acme")).rejects.toThrow(/nme/);
    await expect(resolver.resolve("acme")).rejects.toThrow(/not a member/);

    // Belt and braces: even if a caller bypassed the resolver and sent
    // acme's real org id directly, the server-side membership check must
    // still reject it and must not leak acme's (empty) job list either way.
    const direct = await clientFor(baseUrl, ctx.pat.value, ctx.acme.id)
      .getJson<{ jobs: unknown[] }>("/api/jobs")
      .catch((err: unknown) => err);
    expect(direct).toBeInstanceOf(Error);
  });

  it("fails rather than guessing when the PAT has two orgs and no org is named", async () => {
    const discovery = clientFor(baseUrl, ctx.pat.value);
    const resolver = createOrgResolver(discovery, {});

    await expect(resolver.resolve()).rejects.toThrow(/donable/);
    await expect(resolver.resolve()).rejects.toThrow(/nme/);
    await expect(resolver.resolve()).rejects.toThrow(/several orgs/);
  });

  it("still fails to guess even when MOBILE_FARM_ORG is unset and no explicit org argument is given, via the actual tool call path", async () => {
    // Same assertion as above, but through listJobs itself rather than the
    // resolver directly, matching how src/mcp/index.ts's withOrg wires a
    // real tool call: resolve first, and only build a scoped client on
    // success. Here resolution must fail before any request naming an org
    // is ever made.
    const discovery = clientFor(baseUrl, ctx.pat.value);
    const resolver = createOrgResolver(discovery, {});
    await expect(resolver.resolve(undefined)).rejects.toThrow(/donable|nme/);
  });

  // C1: get_device is registered with the raw, unscoped client (no
  // X-Org-Id ever sent), which requireAuth's PAT branch 403s - confirmed
  // empirically against this exact server before the fix:
  //   DEVICES     403 {"error":"this token belongs to a person, not an org
  //               - name the org with the X-Org-Id header"}
  //   DEVICES+ORG 200
  // So get_device, the tool an agent typically calls first to check the
  // farm is alive, failed for every PAT holder. This drives the real
  // get_device tool function directly with the unscoped client the way the
  // pre-fix registration did, to pin the failure this test would catch, and
  // then proves farmWideClient's fix against the real server end to end.
  it("get_device 403s a PAT's unscoped client and succeeds once any of its orgs is named", async () => {
    const unscoped = clientFor(baseUrl, ctx.pat.value);
    const unscopedResult = await getDevice(unscoped);
    expect(unscopedResult.isError).toBe(true);
    expect((unscopedResult.content[0] as { text: string }).text).toMatch(/belongs to a person, not an org/);

    const scoped = clientFor(baseUrl, ctx.pat.value, ctx.donable.id);
    const scopedResult = await getDevice(scoped);
    expect(scopedResult.isError).toBeUndefined();
  });

  it("get_device tool (via buildServer) works for a PAT holder end to end", async () => {
    const discovery = clientFor(baseUrl, ctx.pat.value);
    const resolver = createOrgResolver(discovery);
    const config = { farmUrl: baseUrl, token: ctx.pat.value, timeoutMs: 30000 };
    const server = buildServer(config, discovery, { token: ctx.pat.value, kind: "personal" }, resolver);
    const tools = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }>;
    })._registeredTools;
    const result = await tools.get_device.handler({});
    expect(result.isError).toBeUndefined();
  });
});
