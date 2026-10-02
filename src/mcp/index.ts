// src/mcp/index.ts
//
// LOAD-BEARING: import the SDK's narrow subpath entrypoints below, never the
// package root ("@modelcontextprotocol/sdk"). The root re-exports the SDK's
// HTTP/OAuth server surface, which drags hono, express and jose into the
// esbuild bundle - the single-file mcp.mjs this branch distributes exists
// precisely because that does not happen. Do not "tidy" these into one
// import; tests/mcp/bundle.test.ts asserts the consequence, not the cause.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import os from "os";
import { loadMcpConfig, type McpConfig, type McpEnvConfig } from "./config";
import { createFarmClient, type FarmClient } from "./client";
import { loadCredential as loadCredentialFromDisk, saveCredential as saveCredentialToDisk, type Credential } from "./credentials";
import { createOrgResolver, type OrgResolver } from "./orgs";
import { getJob, listJobs, getDevice, describeFarmError } from "./tools/reads";
import { runFlows } from "./tools/runFlows";
import { waitForJob } from "./tools/waitForJob";
import { getArtifact } from "./tools/getArtifact";
import { listOrgs } from "./tools/listOrgs";
import type { VersionResponse } from "./apiTypes";
import { errorResult, type ToolResult } from "./result";

/** The SDK's tool callback type structurally requires an index signature
 * (`[x: string]: unknown`) on top of the CallToolResult shape, which our
 * shared `ToolResult` (Task 8, used by every handler and its own tests)
 * deliberately does not carry. The content/isError fields already match
 * what the SDK expects at runtime; this only widens the static type so
 * `registerTool` accepts the handlers unchanged. */
function adapt<T extends Promise<ToolResult>>(result: T): Promise<ToolResult & Record<string, unknown>> {
  return result as unknown as Promise<ToolResult & Record<string, unknown>>;
}

/** Replaced at bundle time by ci/package.sh's esbuild --define. "unknown"
 * is what a from-source run reports, and an unknown version deliberately
 * suppresses the skew warning rather than warning on every dev run. */
declare const __MCP_CLIENT_VERSION__: string | undefined;
/** Also set by esbuild --define, only in the bundled build. Gates the
 * "run as entrypoint" call below - `require.main === module` is invalid
 * once this file is bundled with --format=esm, where `module` does not
 * exist and the createRequire banner does not restore `require.main`. */
declare const __MCP_IS_BUNDLE__: boolean | undefined;

const LOCAL_VERSION = typeof __MCP_CLIENT_VERSION__ === "string" ? __MCP_CLIENT_VERSION__ : "unknown";

/** The version check is advisory, so it gets its own small budget rather
 * than MOBILE_FARM_TIMEOUT_MS (15 minutes by default). GET /api/version
 * shells out to an uncached `maestro --version` on the single-process host
 * that also drives the phone, and agents restart stdio servers constantly -
 * this must be a background courtesy, never something the farm's latency can
 * turn into a hang. */
export const VERSION_CHECK_TIMEOUT_MS = 5000;

/** Advisory only. A client that is a version behind but whose tools all
 * still work should keep working - refusing to start over a version string
 * would be a self-inflicted outage. */
export async function checkVersion(
  client: FarmClient,
  localVersion: string,
  warn: (msg: string) => void,
  // Which re-download instructions to print. An org token's re-curl is a
  // single unauthenticated-by-org command (README.md's CI-only path); a PAT
  // has to name an org via X-Org-Id first (README.md's two-step PAT
  // download flow) - printing the org-token command unconditionally told
  // every PAT user, who is explicitly instructed not to set MOBILE_FARM_TOKEN
  // at all (README.md), to re-run a command referencing a variable they
  // don't have.
  credentialKind: "org" | "personal" = "org",
): Promise<void> {
  if (localVersion === "unknown") return;
  try {
    const remote = await client.getJson<VersionResponse>("/api/version");
    if (remote.version && remote.version !== "unknown" && remote.version !== localVersion) {
      const howTo = credentialKind === "org"
        ? `Re-download it: curl -fsSL -H "Authorization: Bearer $MOBILE_FARM_TOKEN" ` +
          `"$MOBILE_FARM_URL/api/mcp-client" -o ~/.mobile-farm/mcp.mjs`
        : `Re-download it via the two-step PAT flow in README.md's "Set up the MCP client" ` +
          `section (GET /api/me/orgs for an org id, then GET /api/mcp-client with X-Org-Id).`;
      warn(`[mobile-farm-mcp] this mcp-client is version ${localVersion} but the farm is running ${remote.version}. ${howTo}`);
    }
  } catch {
    // Unreachable farm is the tools' problem to report, with a better
    // message than a startup banner could give.
  }
}

/** Every org-scoped call takes the same optional `org` argument. */
const orgArg = z.string().optional()
  .describe("Which of your orgs this call is for. Defaults to MOBILE_FARM_ORG, or your only org.");

/** Builds a client for a route that is farm-wide, not tenant-scoped -
 * currently GET /api/devices (get_device) and GET /api/version (the
 * version-skew check). Both routes ignore `req.org` entirely: grep
 * src/api/devices.ts and `org` only appears in the *write* routes' audit
 * strings (:128, :148, :181, :197), never in a query condition. So for a
 * personal access token, which carries no fixed org, ANY org the holder is
 * a member of satisfies requireAuth's "you must name a selector" guard
 * identically - there is no tenant-specific data behind these two routes to
 * get wrong by picking the "wrong" one.
 *
 * This is deliberately NOT a precedent for guessing an org elsewhere. Every
 * other tool call (run_flows, list_jobs, get_job, get_artifact, ...) uses
 * `org` to select WHOSE data the call touches, and guessing there would risk
 * running a flow against another tenant's device or reading another
 * tenant's job history - exactly what OrgResolver.resolve() refuses to do.
 * Do not copy this pattern onto a route that is not farm-wide in the same
 * sense as these two. */
async function farmWideClient(
  config: McpConfig,
  client: FarmClient,
  credential: Credential,
  resolver: OrgResolver,
): Promise<FarmClient> {
  if (credential.kind === "org") return client;
  const orgs = await resolver.list();
  if (orgs.length === 0) throw new Error("this credential belongs to no orgs");
  // The route ignores the org; any membership satisfies the guard.
  return createFarmClient(config, orgs[0].id);
}

export function buildServer(
  config: McpConfig,
  client: FarmClient,
  credential: Credential,
  resolver: OrgResolver,
): McpServer {
  const server = new McpServer({ name: "deviceyard", version: LOCAL_VERSION });

  /** Personal tokens choose an org per call; an org token has one already
   * and an `org` argument against it is a caller mistake, not something to
   * silently ignore. Never throws past this point - withOrg below turns
   * whatever this raises into an error result. */
  const scopedClient = async (org?: string): Promise<FarmClient> => {
    if (credential.kind === "org") {
      if (org) {
        throw new Error(
          "MOBILE_FARM_TOKEN is an org token, so it already fixes the org - remove the org argument, " +
          "or switch to a personal access token to work across orgs",
        );
      }
      return client;
    }
    const chosen = await resolver.resolve(org);
    return createFarmClient(config, chosen.id);
  };

  /** Resolves the org, builds a scoped client, and runs the tool against
   * it - turning a thrown selection error (or a FarmError from the
   * /api/me/orgs lookup itself) into an error result rather than letting
   * it escape as a throw. */
  const withOrg = async (org: string | undefined, run: (client: FarmClient) => Promise<ToolResult>): Promise<ToolResult> => {
    let scoped: FarmClient;
    try {
      scoped = await scopedClient(org);
    } catch (err) {
      return errorResult(describeFarmError(err));
    }
    return run(scoped);
  };

  /** Same shape as withOrg, but for the farm-wide routes: builds the client
   * via farmWideClient (arbitrary-but-safe org choice for a PAT, see that
   * function's comment) and turns a thrown selection error into an error
   * result rather than letting it escape as a throw. */
  const withFarmWideClient = async (run: (client: FarmClient) => Promise<ToolResult>): Promise<ToolResult> => {
    let scoped: FarmClient;
    try {
      scoped = await farmWideClient(config, client, credential, resolver);
    } catch (err) {
      return errorResult(describeFarmError(err));
    }
    return run(scoped);
  };

  server.registerTool(
    "run_flows",
    {
      description:
        "Run Maestro E2E flows on the physical device. Uploads a built testing APK and the e2e directory, " +
        "exactly as CI does. Returns immediately with a job id - use wait_for_job to follow it.",
      inputSchema: {
        apkPath: z.string().describe("Absolute path to the built testing APK on this machine"),
        flows: z.array(z.string()).describe('Flow identifiers, paths under e2e/scenarios without .yaml, e.g. ["map", "map/filter"]'),
        e2eDir: z.string().optional().describe("Absolute path to the e2e directory. Pass exactly one of e2eDir or flowsArchive."),
        flowsArchive: z.string().optional().describe("Absolute path to a prepared .tar.gz of the e2e directory."),
        org: orgArg,
      },
    },
    (args) => adapt(withOrg(args.org, (c) => runFlows(c, args))),
  );

  server.registerTool(
    "wait_for_job",
    {
      description:
        "Wait for a job to finish and return its results. Returns the last known state if the wait budget " +
        "elapses first - that is not a failure.",
      inputSchema: {
        jobId: z.string(),
        timeoutSeconds: z.number().optional().describe("Wait budget, default 600, clamped to 1-1800"),
        org: orgArg,
      },
    },
    (args) => adapt(withOrg(args.org, (c) => waitForJob(c, args))),
  );

  server.registerTool(
    "get_job",
    {
      description: "Full detail for one job: every flow, its verdict, and the ids of its artifacts.",
      inputSchema: { jobId: z.string(), org: orgArg },
    },
    (args) => adapt(withOrg(args.org, (c) => getJob(c, args))),
  );

  server.registerTool(
    "list_jobs",
    {
      description: "Recent jobs for this org, newest first.",
      // .int(): the limit lands in a SQL `LIMIT ?` on the server, where a
      // fractional value is an error rather than a clamp.
      inputSchema: { limit: z.number().int().optional(), org: orgArg },
    },
    (args) => adapt(withOrg(args.org, (c) => listJobs(c, args))),
  );

  server.registerTool(
    "get_artifact",
    {
      description:
        "Fetch one artifact by id. Screenshots come back as images; maestro.log, stdout and stderr as text; " +
        "recordings as a link.",
      inputSchema: { artifactId: z.number(), org: orgArg },
    },
    (args) => adapt(withOrg(args.org, (c) => getArtifact(c, config.farmUrl, args))),
  );

  server.registerTool(
    "get_device",
    {
      // Deliberately does not claim to report the app build on the phone:
      // the farm has no way to know it (design decision D-2), and a tool
      // description is the only API the agent reading it ever sees.
      // Deliberately has no `org` argument: devices are farm-wide, not
      // scoped to an org, so implying a scoping that does not exist would
      // be worse than the asymmetry with the other tools.
      description:
        "The registered devices - a pool, each either enrolled (accepting work) or not - each with its " +
        "live adb state, the farm's total artifact disk usage (reported once, not per device), and the " +
        "farm's own runner version. Farm-wide - does not take an org argument.",
      inputSchema: {
        org: z.never().optional()
          .describe("Not accepted: devices are farm-wide, not scoped to an org."),
      },
    },
    () => adapt(withFarmWideClient((c) => getDevice(c))),
  );

  server.registerTool(
    "list_orgs",
    {
      description: "List the orgs this credential can act on, and which one calls default to.",
      inputSchema: {},
    },
    () => adapt(listOrgs(resolver, credential)),
  );

  return server;
}

/** Reads the whole of stdin as text. Used only by --save-credential: the
 * token must never be an argv value, which would land in shell history and
 * in `ps` output for the life of the process. */
async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

/** The seams exist for tests: nothing else ever passes these. They are the
 * only way to assert the ordering property this function is responsible for
 * (connect first, version check after) without spawning a real process on a
 * real stdio transport. */
export interface MainDeps {
  loadConfig: () => McpEnvConfig;
  loadCredential: (farmUrl: string) => Credential;
  makeClient: (config: McpConfig, orgId?: number) => FarmClient;
  connect: (server: McpServer) => Promise<void>;
  warn: (msg: string) => void;
  argv: string[];
  readStdin: () => Promise<string>;
  saveCredential: (farmUrl: string, token: string) => void;
}

export async function main(deps: Partial<MainDeps> = {}): Promise<void> {
  // stdout is the JSON-RPC channel. Every diagnostic goes to stderr, or it
  // corrupts the protocol stream.
  const loadConfig = deps.loadConfig ?? loadMcpConfig;
  const loadCredential = deps.loadCredential ?? ((farmUrl: string) => loadCredentialFromDisk(farmUrl));
  const makeClient = deps.makeClient ?? createFarmClient;
  const connect = deps.connect ?? ((server: McpServer) => server.connect(new StdioServerTransport()));
  const warn = deps.warn ?? ((msg: string) => { process.stderr.write(`${msg}\n`); });
  const argv = deps.argv ?? process.argv;
  const readStdinFn = deps.readStdin ?? readStdin;
  const saveCredential = deps.saveCredential ?? ((farmUrl: string, token: string) => saveCredentialToDisk(farmUrl, token, os.homedir()));

  const envConfig = loadConfig();

  // A bootstrapping mode, not a server start: only needs to know which farm
  // the credential is for. Reads the token from stdin only - never argv,
  // which shell history and `ps` would otherwise expose it through.
  if (argv.includes("--save-credential")) {
    const token = (await readStdinFn()).trim();
    if (!token) throw new Error("no token on stdin. Usage: pbpaste | node mcp.mjs --save-credential");
    saveCredential(envConfig.farmUrl, token);
    process.stderr.write(`saved a credential for ${envConfig.farmUrl}\n`);
    return;
  }

  const credential = loadCredential(envConfig.farmUrl);
  const config: McpConfig = { ...envConfig, token: credential.token };
  const client = makeClient(config);
  const resolver = createOrgResolver(client);

  // Connect FIRST. A harness that has just spawned this process is waiting
  // to send `initialize`; anything awaited before connect() is time in which
  // the server looks dead. The version check then runs unawaited, on its own
  // short budget, and cannot throw (checkVersion swallows everything).
  await connect(buildServer(config, client, credential, resolver));

  void (async () => {
    const versionCheckConfig: McpConfig = { ...config, timeoutMs: VERSION_CHECK_TIMEOUT_MS };
    try {
      // Same farm-wide-route reasoning as get_device (see farmWideClient's
      // comment): GET /api/version ignores req.org entirely, so an arbitrary
      // membership is fine here too. Without this, a PAT's version client
      // carried no X-Org-Id, GET /api/version 403'd, and checkVersion's own
      // catch (below) swallowed that 403 - so a PAT user on a stale bundle
      // was never told, silently.
      const versionClient = await farmWideClient(versionCheckConfig, makeClient(versionCheckConfig), credential, resolver);
      await checkVersion(versionClient, LOCAL_VERSION, warn, credential.kind);
    } catch {
      // Advisory only. farmWideClient's own failure (e.g. a PAT that
      // belongs to no orgs yet) is exactly as unworth surfacing at startup
      // as an unreachable farm - checkVersion already swallows the latter.
    }
  })();
}

// Ruling P2: `require.main === module` is invalid in the --format=esm
// bundle a later task produces, since `module` is undefined there. This
// build-time flag is set only by that bundle's esbuild --define; under
// ts-jest (where it is left undeclared) `typeof` on it is safe and false,
// so importing this module for its exports never starts a server.
if (typeof __MCP_IS_BUNDLE__ !== "undefined" && __MCP_IS_BUNDLE__) {
  main().catch((err) => {
    process.stderr.write(`[mobile-farm-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
