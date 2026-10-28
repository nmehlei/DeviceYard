import { CliError, EXIT_ERROR, EXIT_OK } from "./exit";
import { nearest } from "./distance";
import { createFarmClient } from "../../shared/client";
import { parseCloud, parseRead, requireJobId } from "./args";
import { resolveConnection } from "./resolve";
import { runCloud } from "./commands/cloud";
import { runLogin, runLogout, runWhoami } from "./commands/auth";
import { runStatus, runList, runArtifacts } from "./commands/reads";
import { runUpgrade } from "./commands/upgrade";

export interface Io {
  out(s: string): void;
  err(s: string): void;
  env: NodeJS.ProcessEnv;
}

export const KNOWN_COMMANDS = [
  "cloud",
  "status",
  "list",
  "artifacts",
  "login",
  "logout",
  "whoami",
  "upgrade",
] as const;

/** Replaced at build time by ci/package-cli.sh's --define, exactly as
 * __MCP_CLIENT_VERSION__ is for the MCP bundle. "unknown" is what a
 * from-source run reports. */
declare const __CLI_VERSION__: string | undefined;
export const LOCAL_VERSION = typeof __CLI_VERSION__ === "string" ? __CLI_VERSION__ : "unknown";

export const USAGE = `deviceyard - run Maestro flows on a DeviceYard device farm

  deviceyard cloud <app-file> <flows-dir> [flags]   submit a run and wait for it
  deviceyard status <job-id>                        show one job
  deviceyard list                                   recent jobs
  deviceyard artifacts <job-id>                     download a job's artifacts
  deviceyard login | logout | whoami                manage the stored credential
  deviceyard upgrade                                update a binary install

Run 'deviceyard cloud --help' for the cloud flags.`;

export const CLOUD_HELP = `deviceyard cloud <app-file> <flows-dir> [flags]

Connection
  --api-key <key>           API key or token (default: DEVICEYARD_API_KEY)
  --url <url>               the farm (default: DEVICEYARD_URL)
  --org <id>                org to act as (see 'deviceyard whoami')
Choosing flows
  --app-file <path>         the app file, instead of the positional argument
  --flows <path>            the flows path, instead of the positional argument
  --exclude-flows <paths>   comma-separated flow ids or directories to skip
  --include-tags <tags>     only run flows carrying one of these tags
  --exclude-tags <tags>     skip flows carrying one of these tags
  --device-tags <tags>      require all comma-separated device tags (Pro)
  --isolation <mode>        run in a disposable Android work profile (Pro):
                            disabled (default), per-job or per-flow
  --env <KEY=VALUE>         pass an environment variable to the flows
The run
  --name <name>             a name for the run
  --async                   print the job id and exit
  --dry-run                 show what would run without submitting
  --quiet, -q               print no progress
  --debug                   print debug output
Results
  --json                    print the result as JSON
  --json-file               write the result to a JSON file
  --json-file-name <name>   file name for --json-file
  --report junit            write a JUnit report
  --junit-path <path>       where to write the JUnit report
  --download-artifacts <ALL|FAILED>  download artifacts after the run
  --artifacts-path <path>   where to put downloaded artifacts
  --help, -h                show this help

Isolation cost: per-job costs about 15-40 s and about 1.5 GB of device writes per job, and per-flow costs that for every flow (a 27-flow suite writes about 40 GB). Details: https://github.com/nmehlei/DeviceYard/blob/main/docs/guide/isolation.md`;

/** Flags that consume the next argument, so "--name --help" is a name, not a help request. */
const VALUE_FLAGS = new Set([
  "--api-key", "--url", "--org", "--app-file", "--flows", "--exclude-flows", "--device-tags",
  "--isolation", "--include-tags", "--exclude-tags", "--env", "--name", "--json-file-name",
  "--report", "--junit-path", "--download-artifacts", "--artifacts-path",
]);

function wantsHelp(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") return true;
    if (VALUE_FLAGS.has(args[i])) i++;
  }
  return false;
}

export async function run(argv: string[], io: Io): Promise<number> {
  try {
    const [command, ...rest] = argv;

    if (command === "--help" || command === "-h" || command === "help") {
      io.out(USAGE);
      return EXIT_OK;
    }
    if (command === "--version" || command === "-v") {
      io.out(LOCAL_VERSION);
      return EXIT_OK;
    }
    if (!command) throw new CliError(USAGE);

    if (!(KNOWN_COMMANDS as readonly string[]).includes(command)) {
      const near = nearest(command, KNOWN_COMMANDS);
      throw new CliError(
        `unknown command "${command}"${near ? ` - did you mean "${near}"?` : ""}\n\n${USAGE}`,
      );
    }

    if (command === "cloud" && wantsHelp(rest)) {
      io.out(CLOUD_HELP);
      return EXIT_OK;
    }

    if (command === "cloud") {
      const opts = parseCloud(rest);
      const conn = resolveConnection(opts, io.env, undefined, { requireOrg: true });
      const client = createFarmClient(
        { farmUrl: conn.farmUrl, timeoutMs: conn.timeoutMs, token: conn.token },
        conn.orgId,
      );
      return await runCloud(opts, conn, { client, io, now: () => Date.now() });
    }

    if (command === "login") return await runLogin(rest, io, process.stdin);
    if (command === "logout") return runLogout(rest, io);

    if (command === "whoami") {
      // Deliberately NOT { requireOrg: true }: GET /api/me/orgs is the
      // discovery call that accepts a PAT with no org named, and demanding an
      // org id from the command whose job is to tell you your org ids would
      // be circular.
      // Parses --url / --api-key like every other command. Passing {} here
      // meant `deviceyard whoami --url https://farm` answered
      // "DEVICEYARD_URL is required - pass --url" while --url was being
      // passed, and `login --url` worked, so the two siblings disagreed.
      const opts = parseRead(rest);
      const conn = resolveConnection(opts, io.env);
      const client = createFarmClient({
        farmUrl: conn.farmUrl, timeoutMs: conn.timeoutMs, token: conn.token,
      });
      return await runWhoami(conn, client, io);
    }

    if (command === "status" || command === "list" || command === "artifacts") {
      const opts = parseRead(rest);
      const conn = resolveConnection(opts, io.env, undefined, { requireOrg: true });
      const client = createFarmClient(
        { farmUrl: conn.farmUrl, timeoutMs: conn.timeoutMs, token: conn.token },
        conn.orgId,
      );
      if (command === "status") return await runStatus(requireJobId(opts, "status"), client, io);
      if (command === "list") return await runList(opts.limit, client, io);
      return await runArtifacts(
        requireJobId(opts, "artifacts"), opts.downloadArtifacts, opts.artifactsPath, client, io,
      );
    }

    if (command === "upgrade") return runUpgrade(io);

    // Unreachable: every KNOWN_COMMANDS entry is handled above.
    throw new CliError(`"${command}" is not implemented yet`);
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return EXIT_ERROR;
  }
}
