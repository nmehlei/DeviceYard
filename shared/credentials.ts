import fs from "fs";
import os from "os";
import path from "path";
import { normaliseFarmUrl } from "./config";

export interface Credential {
  token: string;
  /** An org token fixes the org; a personal token requires one to be chosen
   * per call. Callers branch on this rather than guessing from the shape of
   * the string. */
  kind: "org" | "personal";
}

export interface CredentialStore {
  credentialsPath(homeDir?: string): string;
  loadCredential(farmUrl: string, env?: NodeJS.ProcessEnv, homeDir?: string): Credential;
  saveCredential(farmUrl: string, token: string, homeDir?: string): void;
}

type CredentialFile = Record<string, { token: string }>;

function readFileIfPresent(file: string): CredentialFile {
  if (!fs.existsSync(file)) return {};
  const mode = fs.statSync(file).mode & 0o077;
  if (mode !== 0) {
    // Deliberately does not echo the path's contents, only its path.
    throw new Error(`${file} is readable by other users; fix its permissions to 0600 and try again`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as CredentialFile;
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
}

/** One implementation, two stores: the MCP client's ~/.mobile-farm and the
 * CLI's ~/.deviceyard. Only the directory name, the token env var and the
 * "no credential" hint differ, so those are the parameters and everything
 * else - the 0600 enforcement, the atomic overwrite, the URL normalisation -
 * is shared. Two copies of this file is how one of them quietly stops
 * enforcing the mode. */
export function createCredentialStore(opts: {
  dirName: string;
  tokenEnvVar: string;
  fallbackTokenEnvVar?: string;
  missingHint: string;
}): CredentialStore {
  const credentialsPath = (homeDir: string = os.homedir()): string =>
    path.join(homeDir, opts.dirName, "credentials");

  return {
    credentialsPath,

    loadCredential(farmUrl, env = process.env, homeDir = os.homedir()) {
      // An explicit env var wins, and is always an org token: that is the
      // cycle-5 contract CI still uses.
      const fromEnv =
        env[opts.tokenEnvVar]?.trim() ||
        (opts.fallbackTokenEnvVar ? env[opts.fallbackTokenEnvVar]?.trim() : undefined);
      if (fromEnv) return { token: fromEnv, kind: "org" };

      const file = credentialsPath(homeDir);
      const entry = readFileIfPresent(file)[normaliseFarmUrl(farmUrl)];
      if (!entry?.token) {
        throw new Error(`no credential for ${normaliseFarmUrl(farmUrl)}. ${opts.missingHint}`);
      }
      return { token: entry.token, kind: "personal" };
    },

    saveCredential(farmUrl, token, homeDir = os.homedir()) {
      const file = credentialsPath(homeDir);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const existing = fs.existsSync(file)
        ? (JSON.parse(fs.readFileSync(file, "utf8")) as CredentialFile)
        : {};
      existing[normaliseFarmUrl(farmUrl)] = { token };

      // Use atomic write pattern: create temp file with restrictive mode, then
      // rename over target. This ensures the token never exists world-readable,
      // even briefly. Node's writeFileSync { mode } only applies when creating
      // (O_CREAT), not when overwriting an existing file — so the standard
      // chmod-after pattern leaves a window on overwrite.
      const content = `${JSON.stringify(existing, null, 2)}\n`;
      const tempFile = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
      try {
        // wx: create only, fail if exists. Mode is always applied on create.
        fs.writeFileSync(tempFile, content, { mode: 0o600, flag: "wx" });
        // Rename is atomic on POSIX systems and carries the source's mode.
        fs.renameSync(tempFile, file);
      } catch (err) {
        // Clean up temp file if something went wrong between create and rename.
        try {
          fs.unlinkSync(tempFile);
        } catch {
          // Temp file cleanup failed, but that's a secondary concern.
        }
        throw err;
      }
    },
  };
}
