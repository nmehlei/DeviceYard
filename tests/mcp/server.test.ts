import http from "http";
import type { AddressInfo } from "net";
import { checkVersion, buildServer } from "../../src/mcp/index";
import { FarmError, type FarmClient } from "../../src/mcp/client";
import type { McpConfig } from "../../src/mcp/config";
import type { Credential } from "../../src/mcp/credentials";
import type { OrgEntry, OrgResolver } from "../../src/mcp/orgs";

function fakeClient(over: Partial<FarmClient> = {}): FarmClient {
  return {
    getJson: async () => ({ version: "1.2.3" }) as never,
    getBinary: async () => ({ bytes: Buffer.alloc(0), contentType: "", totalBytes: 0, partial: false }),
    postForm: async () => ({ id: "x", status: "queued" }),
    openEvents: async () => undefined,
    ...over,
  };
}

function fakeResolver(over: Partial<OrgResolver> = {}): OrgResolver {
  return {
    list: async () => [],
    resolve: async () => { throw new Error("resolve() not stubbed"); },
    describeDefault: () => "no default configured",
    ...over,
  };
}

const orgCredential: Credential = { token: "t", kind: "org" };
const personalCredential: Credential = { token: "t", kind: "personal" };

describe("checkVersion", () => {
  it("says nothing when versions match", async () => {
    const warnings: string[] = [];
    await checkVersion(fakeClient(), "1.2.3", (m) => warnings.push(m));
    expect(warnings).toEqual([]);
  });

  it("warns once, naming both versions and how to fix it", async () => {
    const warnings: string[] = [];
    await checkVersion(fakeClient(), "1.0.0", (m) => warnings.push(m));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("1.0.0");
    expect(warnings[0]).toContain("1.2.3");
    expect(warnings[0]).toContain("mcp-client");
  });

  it("stays silent when the local version is unknown, rather than crying wolf", async () => {
    const warnings: string[] = [];
    await checkVersion(fakeClient(), "unknown", (m) => warnings.push(m));
    expect(warnings).toEqual([]);
  });

  it("never throws when the farm is unreachable", async () => {
    const warnings: string[] = [];
    await expect(checkVersion(fakeClient({
      getJson: async () => { throw new FarmError("down", "unreachable"); },
    }), "1.0.0", (m) => warnings.push(m))).resolves.toBeUndefined();
    expect(warnings).toEqual([]);
  });
});

describe("main", () => {
  const envConfig = { farmUrl: "https://farm.example", timeoutMs: 900000 };

  type IndexModule = typeof import("../../src/mcp/index");
  let mod: IndexModule;

  beforeAll(() => {
    // LOCAL_VERSION is read once at module load from the build-time global
    // esbuild --define injects. Left undefined it is "unknown", checkVersion
    // short-circuits before it ever calls the farm, and these tests could
    // not tell a blocking startup from a non-blocking one. Re-require the
    // module with the global in place so the real code path runs.
    (globalThis as Record<string, unknown>).__MCP_CLIENT_VERSION__ = "9.9.9";
    jest.resetModules();
    mod = require("../../src/mcp/index") as IndexModule;
  });

  afterAll(() => {
    delete (globalThis as Record<string, unknown>).__MCP_CLIENT_VERSION__;
    jest.resetModules();
  });

  /** The seam under test: GET /api/version shells out to an uncached
   * `maestro --version` on the host that also drives the phone, and a farm
   * that black-holes rather than refuses would hold this promise for
   * MOBILE_FARM_TIMEOUT_MS. If startup awaits it, the harness sees a server
   * that never answers `initialize` for up to 15 minutes. */
  function pendingVersionClient(): { client: FarmClient; settle: () => void } {
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    return {
      client: {
        getJson: async () => { await blocked; return {} as never; },
        getBinary: async () => ({ bytes: Buffer.alloc(0), contentType: "", totalBytes: 0, partial: false }),
        postForm: async () => ({ id: "x", status: "queued" }),
        openEvents: async () => undefined,
      },
      settle: release,
    };
  }

  it("connects the transport before the version check has answered", async () => {
    const { client, settle } = pendingVersionClient();
    let connected = false;
    try {
      // Would never resolve against the pre-fix code, which awaited
      // checkVersion before connect().
      await mod.main({
        loadConfig: () => envConfig,
        loadCredential: () => orgCredential,
        makeClient: () => client,
        connect: async () => { connected = true; },
        warn: () => undefined,
      });
      expect(connected).toBe(true);
    } finally {
      settle();
    }
  });

  it("gives the version check its own short budget, not MOBILE_FARM_TIMEOUT_MS", async () => {
    const seen: McpConfig[] = [];
    const { client, settle } = pendingVersionClient();
    try {
      await mod.main({
        loadConfig: () => envConfig,
        loadCredential: () => orgCredential,
        makeClient: (c) => { seen.push(c); return client; },
        connect: async () => undefined,
        warn: () => undefined,
      });
      expect(seen[0].timeoutMs).toBe(900000);
      expect(seen[1].timeoutMs).toBe(mod.VERSION_CHECK_TIMEOUT_MS);
      expect(mod.VERSION_CHECK_TIMEOUT_MS).toBeLessThan(envConfig.timeoutMs);
    } finally {
      settle();
    }
  });

  it("composes loadConfig and loadCredential into the client's McpConfig", async () => {
    const seen: McpConfig[] = [];
    const { client, settle } = pendingVersionClient();
    try {
      await mod.main({
        loadConfig: () => envConfig,
        loadCredential: () => ({ token: "s3cret", kind: "personal" }),
        makeClient: (c) => { seen.push(c); return client; },
        connect: async () => undefined,
        warn: () => undefined,
      });
      expect(seen[0]).toEqual({ farmUrl: "https://farm.example", token: "s3cret", timeoutMs: 900000 });
    } finally {
      settle();
    }
  });

  describe("--save-credential", () => {
    it("reads the token from stdin, never argv, and saves it", async () => {
      let saved: [string, string] | undefined;
      await mod.main({
        loadConfig: () => envConfig,
        argv: ["node", "mcp.mjs", "--save-credential"],
        readStdin: async () => "  a-token-from-stdin  \n",
        saveCredential: (farmUrl, token) => { saved = [farmUrl, token]; },
        warn: () => undefined,
      });
      expect(saved).toEqual(["https://farm.example", "a-token-from-stdin"]);
    });

    it("never starts the server when saving a credential", async () => {
      let connected = false;
      await mod.main({
        loadConfig: () => envConfig,
        argv: ["node", "mcp.mjs", "--save-credential"],
        readStdin: async () => "tok",
        saveCredential: () => undefined,
        connect: async () => { connected = true; },
        warn: () => undefined,
      });
      expect(connected).toBe(false);
    });

    it("throws rather than saving an empty token", async () => {
      await expect(mod.main({
        loadConfig: () => envConfig,
        argv: ["node", "mcp.mjs", "--save-credential"],
        readStdin: async () => "   ",
        saveCredential: () => { throw new Error("must not be called"); },
        warn: () => undefined,
      })).rejects.toThrow(/no token on stdin/);
    });
  });
});

describe("buildServer", () => {
  it("registers exactly the seven specified tools", async () => {
    const server = buildServer(
      { farmUrl: "https://farm.example", token: "t", timeoutMs: 1000 },
      fakeClient(),
      orgCredential,
      fakeResolver(),
    );
    // The SDK's McpServer keeps registered tools in a plain object property
    // (`_registeredTools`, TS-private but a real runtime property, not a
    // JS `#private` field) - assert via that rather than any documented
    // public listing API, since McpServer has none for synchronous,
    // in-process introspection.
    const names = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
    expect(names.sort()).toEqual(
      ["get_artifact", "get_device", "get_job", "list_jobs", "list_orgs", "run_flows", "wait_for_job"],
    );
  });

  type RegisteredTool = { inputSchema: { safeParse: (v: unknown) => { success: boolean } }; handler: (args: unknown, extra?: unknown) => Promise<unknown> };

  function tools(server: unknown): Record<string, RegisteredTool> {
    return (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
  }

  describe("org scoping", () => {
    // scopedClient (src/mcp/index.ts) calls the real createFarmClient for a
    // personal credential, so verifying the org id actually reaches
    // X-Org-Id needs a real loopback listener rather than a fake FarmClient.
    let httpServer: http.Server;
    let httpHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
    let httpBaseUrl: string;

    beforeAll(async () => {
      httpServer = http.createServer((req, res) => httpHandler(req, res));
      await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
      httpBaseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    it("rejects an org argument against an org token rather than ignoring it", async () => {
      const server = buildServer(
        { farmUrl: "https://farm.example", token: "t", timeoutMs: 1000 },
        fakeClient({ getJson: async () => ({ jobs: [] }) as never }),
        orgCredential,
        fakeResolver(),
      );
      const result = await tools(server).list_jobs.handler({ org: "donable" }) as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/org token|MOBILE_FARM_TOKEN/);
    });

    it("resolves the org for a personal credential and scopes the client actually used", async () => {
      const orgs: OrgEntry[] = [{ id: 7, name: "donable" }];
      let resolvedWith: string | undefined;
      let seenOrgHeader: string | undefined;
      httpHandler = (req, res) => {
        seenOrgHeader = req.headers["x-org-id"] as string | undefined;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jobs: [] }));
      };
      const resolver = fakeResolver({
        resolve: async (explicit) => { resolvedWith = explicit; return orgs[0]; },
      });
      const server = buildServer(
        { farmUrl: httpBaseUrl, token: "t", timeoutMs: 2000 },
        fakeClient(),
        personalCredential,
        resolver,
      );
      const result = await tools(server).list_jobs.handler({ org: "donable" }) as { isError?: boolean };
      expect(resolvedWith).toBe("donable");
      expect(result.isError).toBeFalsy();
      expect(seenOrgHeader).toBe("7");
    });

    it("turns a selection failure (several orgs, none named) into an error result, never a throw", async () => {
      const resolver = fakeResolver({
        resolve: async () => { throw new Error("you belong to several orgs: donable, nme"); },
      });
      const server = buildServer(
        { farmUrl: "https://farm.example", token: "t", timeoutMs: 1000 },
        fakeClient(),
        personalCredential,
        resolver,
      );
      const result = await tools(server).list_jobs.handler({}) as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("donable, nme");
    });

    it("get_device's schema rejects an org argument, since devices are farm-wide", async () => {
      const server = buildServer(
        { farmUrl: "https://farm.example", token: "t", timeoutMs: 1000 },
        fakeClient(),
        orgCredential,
        fakeResolver(),
      );
      const parsed = tools(server).get_device.inputSchema.safeParse({ org: "donable" });
      expect(parsed.success).toBe(false);
    });

    it("get_device still works with no arguments", async () => {
      const server = buildServer(
        { farmUrl: "https://farm.example", token: "t", timeoutMs: 1000 },
        fakeClient({ getJson: async () => ({ devices: [] }) as never }),
        orgCredential,
        fakeResolver(),
      );
      const result = await tools(server).get_device.handler({}) as { isError?: boolean };
      expect(result.isError).toBeFalsy();
    });

    it("registers list_orgs, which lists what the resolver reports", async () => {
      const resolver = fakeResolver({ list: async () => [{ id: 1, name: "donable" }] });
      const server = buildServer(
        { farmUrl: "https://farm.example", token: "t", timeoutMs: 1000 },
        fakeClient(),
        personalCredential,
        resolver,
      );
      const result = await tools(server).list_orgs.handler({}) as { content: Array<{ text: string }> };
      expect(result.content[0].text).toContain("donable");
    });
  });
});
