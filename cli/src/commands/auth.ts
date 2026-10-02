import fs from "fs";
import { normaliseFarmUrl } from "../../../shared/config";
import type { FarmClient } from "../../../shared/client";
import { credentials, type Resolved } from "../resolve";
import { CliError, EXIT_ERROR, EXIT_OK } from "../exit";
import type { Io } from "../main";

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function farmUrlFrom(url: string | undefined, io: Io): string {
  const raw = url ?? io.env.DEVICEYARD_URL ?? io.env.MOBILE_FARM_URL ?? "";
  if (!raw.trim()) throw new CliError("pass --url https://your-farm, or set DEVICEYARD_URL");
  return normaliseFarmUrl(raw.trim());
}

/** Reads the token from STDIN ONLY - never an argv, which would land in shell
 * history and in `ps` output where any other user on the box can read it.
 * Same contract as `mcp.mjs --save-credential`. */
export async function runLogin(
  argv: string[],
  io: Io,
  stdin: NodeJS.ReadableStream,
  homeDir?: string,
): Promise<number> {
  try {
    let url: string | undefined;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--url") {
        const value = argv[++i];
        if (value === undefined) throw new CliError("--url requires a value");
        url = value;
        continue;
      }
      throw new CliError(
        `deviceyard login takes no token argument - it reads the token from stdin:\n` +
        `  deviceyard login --url https://your-farm   # paste, then Ctrl-D\n` +
        `  pbpaste | deviceyard login --url https://your-farm`,
      );
    }

    const farmUrl = farmUrlFrom(url, io);
    const token = (await readAll(stdin)).trim();
    if (!token) throw new CliError("no token was read from stdin");

    credentials.saveCredential(farmUrl, token, homeDir);
    io.out(`saved a credential for ${farmUrl} in ${credentials.credentialsPath(homeDir)} (0600)`);
    return EXIT_OK;
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return EXIT_ERROR;
  }
}

/** Removes one farm's entry, or the whole file when no farm is named.
 * Rewrites through the same wx+rename atomic 0600 path saveCredential uses,
 * so a logout cannot leave a world-readable file behind. */
export function runLogout(argv: string[], io: Io, homeDir?: string): number {
  try {
    let url: string | undefined;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--url") {
        const value = argv[++i];
        if (value === undefined) throw new CliError("--url requires a value");
        url = value;
        continue;
      }
      throw new CliError(
        `unknown argument "${argv[i]}" - usage: deviceyard logout [--url https://your-farm]`,
      );
    }

    const file = credentials.credentialsPath(homeDir);
    if (!fs.existsSync(file)) {
      io.out("no stored credentials");
      return EXIT_OK;
    }

    if (!url) {
      fs.rmSync(file);
      io.out(`removed ${file}`);
      return EXIT_OK;
    }

    const key = normaliseFarmUrl(url);
    const all = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, { token: string }>;
    if (!(key in all)) {
      io.out(`no stored credential for ${key}`);
      return EXIT_OK;
    }

    delete all[key];
    if (Object.keys(all).length === 0) {
      fs.rmSync(file);
    } else {
      const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
      try {
        fs.writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600, flag: "wx" });
        fs.renameSync(tmp, file);
      } catch (err) {
        try { fs.unlinkSync(tmp); } catch { /* secondary concern */ }
        throw err;
      }
    }
    io.out(`removed the credential for ${key}`);
    return EXIT_OK;
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return EXIT_ERROR;
  }
}

export async function runWhoami(conn: Resolved, client: FarmClient, io: Io): Promise<number> {
  // An ORG token carries no person identity, so GET /api/me/orgs answers
  // 401 "login required" for it - correctly, but the raw error reads as
  // "your credential is bad" when the credential is fine and simply is not a
  // person. Found by running this against a live farm with a CI token.
  //
  // There is nothing to discover for an org token: it is bound to exactly one
  // org by construction. So confirm it WORKS instead, against the frozen
  // org-scoped CI route, and say what it is.
  if (conn.kind === "org") {
    try {
      await client.getJson<unknown[]>("/jobs");
    } catch (err) {
      io.err(err instanceof Error ? err.message : String(err));
      return EXIT_ERROR;
    }
    io.out(`${conn.farmUrl}  (org token)`);
    io.out("  valid, and bound to the single org it was issued for.");
    io.out("  An org token names no person, so there are no orgs to list.");
    io.out("  Run `deviceyard login` with a personal access token to see the orgs you belong to.");
    return EXIT_OK;
  }

  // GET /api/me/orgs is the discovery call: it accepts a PAT with no org
  // named, which is exactly the situation someone running `whoami` is in.
  const { orgs } = await client.getJson<{ orgs: Array<{ id: number; name: string }> }>("/api/me/orgs");
  io.out(`${conn.farmUrl}  (personal access token)`);
  if (orgs.length === 0) {
    io.out("  (no orgs)");
    return EXIT_OK;
  }
  for (const org of orgs) io.out(`  ${org.id}  ${org.name}`);
  return EXIT_OK;
}
