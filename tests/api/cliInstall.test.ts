import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { cliRoutes } from "../../src/api/cli";

describe("GET /cli/install.sh", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "dy-inst-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const app = (p: string) => express().use(cliRoutes({ installScriptPath: p }));

  it("serves the script as shell text", async () => {
    const p = path.join(dir, "install.sh");
    fs.writeFileSync(p, "#!/bin/sh\necho hi\n");
    const res = await request(app(p)).get("/cli/install.sh");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/x-shellscript/);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.text).toContain("echo hi");
  });

  it("is reachable WITHOUT a credential", async () => {
    // The whole point: you install the CLI before you have a token. This
    // router carries no auth of its own and must be mounted ahead of the org
    // gate in src/server.ts.
    const p = path.join(dir, "install.sh");
    fs.writeFileSync(p, "#!/bin/sh\n");
    expect((await request(app(p)).get("/cli/install.sh")).status).toBe(200);
  });

  it("503s when this build shipped no script", async () => {
    const res = await request(app(path.join(dir, "absent.sh"))).get("/cli/install.sh");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "the CLI install script is not available in this build" });
  });
});

describe("the /cli page and the /cli/install.sh route coexist", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "dy-both-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("does not let the install route swallow the /cli page route", async () => {
    // cliRoutes is mounted BEFORE the page routes, so a router that matched
    // too broadly would take /cli with it and the quick start page would
    // become a 404 - silently, and only in production.
    const script = path.join(dir, "install.sh");
    fs.writeFileSync(script, "#!/bin/sh\n");

    const app = express()
      .use(cliRoutes({ installScriptPath: script }))
      .get("/cli", (_req, res) => { res.status(200).type("html").send("<html>page</html>"); });

    expect((await request(app).get("/cli")).text).toContain("page");
    expect((await request(app).get("/cli/install.sh")).text).toContain("#!/bin/sh");
  });
});
