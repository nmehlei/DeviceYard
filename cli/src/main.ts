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

Run 'deviceyard cloud --help' for the full flag list.`;

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
