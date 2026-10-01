import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import express, { type Request, type Response } from "express";
import { openDatabase, type Db } from "../../src/db/driver";
import { migrate } from "../../src/db/migrations";
import { JobRepository } from "../../src/store/jobRepository";
import { DeviceRepository } from "../../src/store/deviceRepository";
import { JobEvents } from "../../src/events";
import { jobRoutes } from "../../src/api/jobs";

/**
 * Express doesn't publicly type Router#stack, but its shape is stable at
 * runtime; this lets a test reach in and call the SSE route's handler
 * directly with hand-built req/res doubles, instead of driving it through a
 * real socket. That is what makes the writableEnded-guard test below
 * deterministic rather than racing a client disconnect against the server
 * noticing it.
 */
interface RouterInternals {
  stack: Array<{ route?: { path: string; stack: Array<{ handle: (req: Request, res: Response) => void }> } }>;
}

function findRouteHandler(
  router: ReturnType<typeof jobRoutes>,
  routePath: string
): (req: Request, res: Response) => void {
  const layer = (router as unknown as RouterInternals).stack.find((l) => l.route?.path === routePath);
  const handle = layer?.route?.stack[0]?.handle;
  if (!handle) throw new Error(`no handler found for route ${routePath}`);
  return handle;
}

let dir: string;
let db: Db;
let repo: JobRepository;
let deviceRepo: DeviceRepository;
let events: JobEvents;

function app() {
  const a = express();
  // Stand-in for the real auth middleware; auth itself is tested elsewhere.
  a.use((req, _res, next) => {
    req.org = "donable";
    next();
  });
  a.use(jobRoutes({ repo, events, dataDir: dir }));
  return a;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-api-"));
  db = openDatabase(path.join(dir, "farm.db"));
  migrate(db);
  repo = new JobRepository(db);
  deviceRepo = new DeviceRepository(db);
  deviceRepo.seedIfEmpty("dev-1");
  events = new JobEvents();
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("createJob persists and round-trips appId/appVersion when supplied", () => {
  const job = repo.createJob("donable", ["a"], undefined, "com.example.app", "2.4.1 (240)");
  const fetched = repo.getJob(job.id);
  expect(fetched?.appId).toBe("com.example.app");
  expect(fetched?.appVersion).toBe("2.4.1 (240)");
});

test("createJob without appId/appVersion defaults both to null", () => {
  const job = repo.createJob("donable", ["a"]);
  const fetched = repo.getJob(job.id);
  expect(fetched?.appId).toBeNull();
  expect(fetched?.appVersion).toBeNull();
});

test("GET /api/jobs summarises progress without shipping every step", async () => {
  const job = repo.createJob("donable", ["a", "b"]);
  const step = repo.startStep(job.id, "a");
  repo.finishStep(step.id, { status: "passed" });

  const res = await request(app()).get("/api/jobs");

  expect(res.status).toBe(200);
  expect(res.body.jobs).toHaveLength(1);
  expect(res.body.jobs[0]).toMatchObject({
    id: job.id,
    status: "queued",
    flowCount: 2,
    passed: 1,
    failed: 0,
  });
  expect(res.body.jobs[0].steps).toBeUndefined();
});

test("GET /api/jobs excludes other orgs", async () => {
  repo.createJob("other", ["a"]);
  const res = await request(app()).get("/api/jobs");
  expect(res.body.jobs).toEqual([]);
});

test("GET /api/jobs clamps a negative or zero limit instead of dumping everything", async () => {
  repo.createJob("donable", ["a"]);
  repo.createJob("donable", ["a"]);
  repo.createJob("donable", ["a"]);

  // SQLite treats a negative LIMIT as unbounded, so ?limit=-1 must be
  // clamped up to at least 1, not passed straight through.
  const negative = await request(app()).get("/api/jobs?limit=-1");
  expect(negative.status).toBe(200);
  expect(negative.body.jobs.length).toBe(1);

  // ?limit=0 must fall back to the default page, not return nothing (and
  // not become unbounded either).
  const zero = await request(app()).get("/api/jobs?limit=0");
  expect(zero.status).toBe(200);
  expect(zero.body.jobs.length).toBe(3);
});

test("GET /api/jobs/:id returns the full step timeline", async () => {
  const job = repo.createJob("donable", ["a"]);

  const res = await request(app()).get(`/api/jobs/${job.id}`);

  expect(res.status).toBe(200);
  expect(res.body.job.id).toBe(job.id);
  expect(res.body.steps.map((s: { name: string }) => s.name)).toEqual(["device", "install", "extract", "a"]);
  expect(res.body.steps[0]).toHaveProperty("artifacts");
});

test("GET /api/jobs/:id for another org's job is a 404", async () => {
  const job = repo.createJob("other", ["a"]);
  const res = await request(app()).get(`/api/jobs/${job.id}`);
  expect(res.status).toBe(404);
});

test("the SSE stream sends full state on connect", async () => {
  const job = repo.createJob("donable", ["a"]);

  const res = await request(app())
    .get(`/api/jobs/${job.id}/events`)
    .buffer(true)
    .parse((res, cb) => {
      // superagent's ResponseBase type omits `destroy`, but at runtime this
      // is the raw node http.IncomingMessage, which has it.
      const stream = res as unknown as NodeJS.ReadableStream & { destroy: () => void };
      let data = "";
      stream.on("data", (chunk) => {
        data += chunk;
        // The job is terminal-less here, so close as soon as the first frame
        // lands rather than waiting for the stream to end on its own.
        if (data.includes("\n\n")) stream.destroy();
      });
      stream.on("close", () => cb(null, data));
    });

  expect(res.headers["content-type"]).toContain("text/event-stream");
  expect(res.body).toContain(job.id);
});

test("send() is a no-op once the response has already ended", () => {
  const job = repo.createJob("donable", ["a"]);
  const handle = findRouteHandler(jobRoutes({ repo, events, dataDir: dir }), "/api/jobs/:id/events");

  const writes: string[] = [];
  const fakeRes = {
    writableEnded: false,
    writeHead: () => fakeRes,
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
    end: () => {
      fakeRes.writableEnded = true;
    },
    destroyed: false,
    // The route now also attaches a res.on("error", ...) cleanup handler
    // alongside req.on("close", ...); this double is a no-op stand-in for it.
    on: () => fakeRes,
  };
  const fakeReq = {
    params: { id: job.id },
    org: "donable",
    on: () => undefined,
  };

  handle(fakeReq as unknown as Request, fakeRes as unknown as Response);

  // The job isn't terminal, so the initial send() writes one frame and
  // leaves the connection open (and the send() listener still subscribed).
  expect(writes).toHaveLength(1);
  expect(fakeRes.writableEnded).toBe(false);

  // Force the exact state the guard exists for: the response has already
  // ended (e.g. the client's socket closed and Node tore it down) before
  // the "close" handler's unsubscribe has run, so the listener above is
  // still registered. A publish arriving in that window must not write to
  // the closed response or throw.
  fakeRes.writableEnded = true;

  expect(() => events.publish(job.id)).not.toThrow();
  expect(writes).toHaveLength(1);
});

test("the dashboard job routes expose which device ran the job", async () => {
  const job = repo.createJob("donable", ["a"]);
  repo.claimNextQueued("dev-1");

  const detail = await request(app()).get(`/api/jobs/${job.id}`);
  expect(detail.body.job.deviceId).toBe("dev-1");

  const list = await request(app()).get("/api/jobs");
  expect(list.body.jobs[0].deviceId).toBe("dev-1");
});

// The mirror assertion - that the frozen CI route /run/:id does NOT gain
// deviceId - deliberately does not live here: app() mounts only jobRoutes,
// so a request to /run/:id 404s and any assertion about its body passes
// regardless of what the real route does. tests/contract/ciContract.test.ts
// pins that response's keys exactly, against the real server.
