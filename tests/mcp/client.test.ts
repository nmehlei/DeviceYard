// tests/mcp/client.test.ts
import http from "http";
import type { AddressInfo } from "net";
import { createFarmClient, FarmError } from "../../src/mcp/client";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

let server: http.Server;
let handler: Handler;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const client = () => createFarmClient({ farmUrl: baseUrl, token: "s3cret", timeoutMs: 2000 });

describe("getJson", () => {
  it("sends the bearer token in the Authorization header", async () => {
    let seen: string | undefined;
    handler = (req, res) => {
      seen = req.headers.authorization;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    };
    await expect(client().getJson<{ ok: boolean }>("/api/jobs")).resolves.toEqual({ ok: true });
    expect(seen).toBe("Bearer s3cret");
  });

  it("never puts the token in the URL, where it would land in access logs", async () => {
    let seenUrl: string | undefined;
    handler = (req, res) => {
      seenUrl = req.url;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    };
    await client().getJson("/api/jobs?limit=5");
    expect(seenUrl).toBe("/api/jobs?limit=5");
    expect(seenUrl).not.toContain("s3cret");
  });

  it("maps 401 to kind 'auth'", async () => {
    handler = (_req, res) => { res.writeHead(401); res.end("nope"); };
    const err = await client().getJson("/api/jobs").catch((e) => e as FarmError);
    expect(err).toBeInstanceOf(FarmError);
    expect((err as FarmError).kind).toBe("auth");
    expect((err as FarmError).status).toBe(401);
  });

  // I2: the pre-fix code read the 403 body and then discarded it, throwing a
  // fixed "Check MOBILE_FARM_TOKEN" message regardless of what the server
  // actually said. That loses the one piece of information ("not a member of
  // that org", "this token belongs to a person, not an org...") that tells
  // the agent (or its human) what to actually do differently.
  it("includes the server's own reason in the error, not just a fixed hint", async () => {
    handler = (_req, res) => {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "this token belongs to a person, not an org - name the org with the X-Org-Id header" }));
    };
    const err = await client().getJson("/api/devices").catch((e) => e as FarmError);
    expect((err as FarmError).kind).toBe("auth");
    expect((err as FarmError).message).toContain("this token belongs to a person, not an org");
  });

  it("maps 404 to kind 'not_found'", async () => {
    handler = (_req, res) => { res.writeHead(404); res.end("gone"); };
    const err = await client().getJson("/api/jobs/x").catch((e) => e as FarmError);
    expect((err as FarmError).kind).toBe("not_found");
  });

  it("maps 500 to kind 'server' and includes the body for diagnosis", async () => {
    handler = (_req, res) => { res.writeHead(500); res.end("boom"); };
    const err = await client().getJson("/api/jobs").catch((e) => e as FarmError);
    expect((err as FarmError).kind).toBe("server");
    expect((err as FarmError).message).toContain("boom");
  });

  it("redacts the token if the server echoes it back in an error body", async () => {
    handler = (_req, res) => { res.writeHead(500); res.end("token s3cret rejected"); };
    const err = await client().getJson("/api/jobs").catch((e) => e as FarmError);
    expect((err as FarmError).message).not.toContain("s3cret");
    expect((err as FarmError).message).toContain("<redacted>");
  });

  it("maps a connection failure to kind 'unreachable' without leaking credentials", async () => {
    const dead = createFarmClient({ farmUrl: "http://127.0.0.1:1", token: "s3cret", timeoutMs: 2000 });
    const err = await dead.getJson("/api/jobs").catch((e) => e as FarmError);
    expect((err as FarmError).kind).toBe("unreachable");
    expect((err as FarmError).message).not.toContain("s3cret");
  });

  it("maps a slow response to kind 'timeout'", async () => {
    handler = () => { /* never respond */ };
    const slow = createFarmClient({ farmUrl: baseUrl, token: "s3cret", timeoutMs: 150 });
    const err = await slow.getJson("/api/jobs").catch((e) => e as FarmError);
    expect((err as FarmError).kind).toBe("timeout");
  });

  it("lets one call take a tighter timeout than the client default", async () => {
    // A poll for a job that already finished must not inherit the 15-minute
    // default: a stalled connection then outlives the pipeline's own job limit.
    handler = () => { /* never respond */ };
    const started = Date.now();
    const err = await createFarmClient({ farmUrl: baseUrl, token: "s3cret", timeoutMs: 60_000 })
      .getJson("/api/jobs/x", { timeoutMs: 150 })
      .catch((e) => e as FarmError);
    expect((err as FarmError).kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("times out a response whose headers arrive but whose body then stalls", async () => {
    // The failure the old code could not see: the timer was cleared as soon
    // as fetch() resolved (headers received), leaving the body read - which
    // is where a host at 99% disk actually stalls - completely unbounded.
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"partial":');
      // body deliberately never completed, connection left open
    };
    const slow = createFarmClient({ farmUrl: baseUrl, token: "s3cret", timeoutMs: 200 });
    const err = await slow.getJson("/api/jobs").catch((e) => e as FarmError);
    expect(err).toBeInstanceOf(FarmError);
    expect((err as FarmError).kind).toBe("timeout");
  });

  it("turns a 200 that is not JSON into a FarmError, not a raw SyntaxError", async () => {
    // A misconfigured MOBILE_FARM_URL landing on dashboard HTML, or a proxy
    // interstitial. res.json() would have thrown a SyntaxError straight past
    // the redaction funnel.
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><html><body>login</body></html>");
    };
    const err = await client().getJson("/api/jobs").catch((e) => e as Error);
    expect(err).toBeInstanceOf(FarmError);
    expect(err).not.toBeInstanceOf(SyntaxError);
    expect((err as FarmError).kind).toBe("server");
    expect((err as FarmError).message).toContain("non-JSON");
  });

  it("redacts the token from a non-JSON body it echoes back", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>token s3cret</html>");
    };
    const err = await client().getJson("/api/jobs").catch((e) => e as FarmError);
    expect((err as FarmError).message).not.toContain("s3cret");
  });
});

describe("getBinary", () => {
  it("returns raw bytes and the declared content type", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(Buffer.from([1, 2, 3]));
    };
    const out = await client().getBinary("/api/artifacts/1");
    expect(out.contentType).toBe("image/png");
    expect(Array.from(out.bytes)).toEqual([1, 2, 3]);
    expect(out.partial).toBe(false);
    expect(out.totalBytes).toBe(3);
  });

  it("sends a Range header and reports the total size from Content-Range", async () => {
    let seenRange: string | undefined;
    handler = (req, res) => {
      seenRange = req.headers.range;
      res.writeHead(206, { "Content-Type": "video/mp4", "Content-Range": "bytes 0-0/12345678" });
      res.end(Buffer.from([9]));
    };
    const out = await client().getBinary("/api/artifacts/1", { start: 0, end: 0 });
    expect(seenRange).toBe("bytes=0-0");
    expect(out.partial).toBe(true);
    expect(out.totalBytes).toBe(12345678);
    expect(out.bytes.byteLength).toBe(1);
  });

  it("sends an open-ended range when no end is given", async () => {
    let seenRange: string | undefined;
    handler = (req, res) => {
      seenRange = req.headers.range;
      res.writeHead(206, { "Content-Range": "bytes 5-9/10" });
      res.end(Buffer.from("world"));
    };
    await client().getBinary("/api/artifacts/1", { start: 5 });
    expect(seenRange).toBe("bytes=5-");
  });

  it("degrades to the whole body when the server ignores Range and answers 200", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("the whole file");
    };
    const out = await client().getBinary("/api/artifacts/1", { start: 0, end: 0 });
    expect(out.partial).toBe(false);
    expect(out.bytes.toString()).toBe("the whole file");
    expect(out.totalBytes).toBe("the whole file".length);
  });

  it("times out a binary body that stalls after its headers", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": "1024" });
      res.write(Buffer.alloc(8));
      // never finishes the declared 1024 bytes
    };
    const slow = createFarmClient({ farmUrl: baseUrl, token: "s3cret", timeoutMs: 200 });
    const err = await slow.getBinary("/api/artifacts/1").catch((e) => e as FarmError);
    expect((err as FarmError).kind).toBe("timeout");
  });
});

describe("org scoping", () => {
  it("sends X-Org-Id when the client is bound to an org", async () => {
    let seen: string | undefined;
    handler = (req, res) => {
      seen = req.headers["x-org-id"] as string | undefined;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    };
    const scoped = createFarmClient({ farmUrl: baseUrl, token: "t", timeoutMs: 2000 }, 42);
    await scoped.getJson("/api/jobs");
    expect(seen).toBe("42");
  });

  it("omits X-Org-Id when unscoped, so an org token behaves exactly as before", async () => {
    let seen: string | undefined;
    handler = (req, res) => {
      seen = req.headers["x-org-id"] as string | undefined;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    };
    await createFarmClient({ farmUrl: baseUrl, token: "t", timeoutMs: 2000 }).getJson("/api/jobs");
    expect(seen).toBeUndefined();
  });
});

describe("openEvents", () => {
  it("parses data: frames and stops when the server ends the stream", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: {\"n\":1}\n\n");
      res.write("data: {\"n\":2}\n\n");
      res.end();
    };
    const frames: unknown[] = [];
    await client().openEvents("/api/jobs/x/events", (f) => frames.push(f), new AbortController().signal);
    expect(frames).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("stops when the caller aborts", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: {\"n\":1}\n\n");
      // deliberately left open
    };
    const controller = new AbortController();
    const frames: unknown[] = [];
    const done = client().openEvents("/api/jobs/x/events", (f) => {
      frames.push(f);
      controller.abort();
    }, controller.signal);
    await expect(done).resolves.toBeUndefined();
    expect(frames).toEqual([{ n: 1 }]);
  });

  it("skips a malformed frame without tearing down the stream", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: {\"n\":1}\n\n");
      res.write("data: not-json\n\n");
      res.write("data: {\"n\":2}\n\n");
      res.end();
    };
    const frames: unknown[] = [];
    await client().openEvents("/api/jobs/x/events", (f) => frames.push(f), new AbortController().signal);
    expect(frames).toEqual([{ n: 1 }, { n: 2 }]);
  });
});
