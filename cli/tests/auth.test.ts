import fs from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { runLogin, runLogout, runWhoami } from "../src/commands/auth";
import { credentials } from "../src/resolve";
import { EXIT_OK, EXIT_ERROR } from "../src/exit";
import type { Io } from "../src/main";
import type { FarmClient } from "../../shared/client";

const URL = "https://f.example.com";

function io(env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const i: Io = { out: (s) => out.push(s), err: (s) => err.push(s), env };
  return { io: i, out, err };
}

describe("runLogin", () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "dy-login-")); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it("reads the token from stdin and stores it 0600", async () => {
    const { io: i } = io();
    expect(await runLogin(["--url", URL], i, Readable.from(["pat-abc\n"]), home)).toBe(EXIT_OK);
    const file = credentials.credentialsPath(home);
    expect(fs.statSync(file).mode & 0o077).toBe(0);
    expect(credentials.loadCredential(URL, {}, home).token).toBe("pat-abc");
  });

  it("never echoes the token back", async () => {
    const { io: i, out, err } = io();
    await runLogin(["--url", URL], i, Readable.from(["pat-abc\n"]), home);
    expect([...out, ...err].join("\n")).not.toContain("pat-abc");
  });

  it("refuses a token passed as an argument", async () => {
    // An argv lands in shell history and in ps output. Rejecting it is the point.
    const { io: i, err } = io();
    expect(await runLogin(["--url", URL, "pat-abc"], i, Readable.from([""]), home)).toBe(EXIT_ERROR);
    expect(err.join("\n")).toMatch(/reads the token from stdin/);
  });

  it("fails when stdin is empty", async () => {
    const { io: i, err } = io();
    expect(await runLogin(["--url", URL], i, Readable.from([""]), home)).toBe(EXIT_ERROR);
    expect(err.join("\n")).toMatch(/no token was read/);
  });

  it("takes the URL from the environment when --url is absent", async () => {
    const { io: i } = io({ DEVICEYARD_URL: URL });
    expect(await runLogin([], i, Readable.from(["pat-xyz"]), home)).toBe(EXIT_OK);
    expect(credentials.loadCredential(URL, {}, home).token).toBe("pat-xyz");
  });

  it("fails with a usable message when no URL is available", async () => {
    const { io: i, err } = io();
    expect(await runLogin([], i, Readable.from(["t"]), home)).toBe(EXIT_ERROR);
    expect(err.join("\n")).toMatch(/--url/);
  });
});

describe("runLogout", () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "dy-logout-")); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it("removes one farm's entry and leaves the others", () => {
    credentials.saveCredential(URL, "a", home);
    credentials.saveCredential("https://other.example.com", "b", home);
    const { io: i } = io();
    expect(runLogout(["--url", URL], i, home)).toBe(EXIT_OK);
    expect(() => credentials.loadCredential(URL, {}, home)).toThrow(/no credential/);
    expect(credentials.loadCredential("https://other.example.com", {}, home).token).toBe("b");
  });

  it("keeps the file 0600 after a partial removal", () => {
    credentials.saveCredential(URL, "a", home);
    credentials.saveCredential("https://other.example.com", "b", home);
    runLogout(["--url", URL], io().io, home);
    expect(fs.statSync(credentials.credentialsPath(home)).mode & 0o077).toBe(0);
  });

  it("removes the whole file when no farm is named", () => {
    credentials.saveCredential(URL, "a", home);
    expect(runLogout([], io().io, home)).toBe(EXIT_OK);
    expect(fs.existsSync(credentials.credentialsPath(home))).toBe(false);
  });

  it("is a no-op, not an error, when nothing is stored", () => {
    const { io: i, out } = io();
    expect(runLogout([], i, home)).toBe(EXIT_OK);
    expect(out.join("\n")).toContain("no stored credentials");
  });

  it("rejects an unknown argument", () => {
    const { io: i, err } = io();
    expect(runLogout(["--nope"], i, home)).toBe(EXIT_ERROR);
    expect(err.join("\n")).toContain("unknown argument");
  });
});

describe("runWhoami", () => {
  it("does not call the person-only route with an org token", async () => {
    // GET /api/me/orgs answers 401 for an org token - correctly, since an org
    // token names no person. Surfacing that raw read as "your credential is
    // bad" when it is perfectly valid. Caught against a live farm.
    const called: string[] = [];
    const client = {
      async getJson(p: string) {
        called.push(p);
        if (p === "/api/me/orgs") throw new Error("login required");
        return [] as never;
      },
    } as unknown as FarmClient;
    const { io: i, out } = io();
    const conn = { farmUrl: URL, timeoutMs: 1, token: "t", kind: "org" as const };
    expect(await runWhoami(conn, client, i)).toBe(EXIT_OK);
    expect(called).not.toContain("/api/me/orgs");
    expect(out.join("\n")).toContain("org token");
    expect(out.join("\n")).toMatch(/valid/);
  });

  it("reports an org token that the farm rejects", async () => {
    const client = {
      async getJson() { throw new Error("the farm rejected the credential (HTTP 403)"); },
    } as unknown as FarmClient;
    const { io: i, err } = io();
    const conn = { farmUrl: URL, timeoutMs: 1, token: "bad", kind: "org" as const };
    expect(await runWhoami(conn, client, i)).toBe(EXIT_ERROR);
    expect(err.join("\n")).toContain("403");
  });

  it("lists the orgs from the discovery call", async () => {
    const { io: i, out } = io();
    const client = {
      async getJson() { return { orgs: [{ id: 1, name: "donable" }, { id: 2, name: "momentum" }] } as never; },
    } as unknown as FarmClient;
    const conn = { farmUrl: URL, timeoutMs: 1, token: "t", kind: "personal" as const };
    expect(await runWhoami(conn, client, i)).toBe(EXIT_OK);
    expect(out.join("\n")).toContain("donable");
    expect(out.join("\n")).toContain("momentum");
    expect(out.join("\n")).toContain("personal");
  });

  it("never prints the token", async () => {
    const { io: i, out } = io();
    const client = { async getJson() { return { orgs: [] } as never; } } as unknown as FarmClient;
    await runWhoami({ farmUrl: URL, timeoutMs: 1, token: "s3cret", kind: "org" }, client, i);
    expect(out.join("\n")).not.toContain("s3cret");
  });
});
