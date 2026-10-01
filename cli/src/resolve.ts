import { loadFarmConfig, normaliseFarmUrl } from "../../shared/config";
import { createCredentialStore } from "../../shared/credentials";
import { CliError } from "./exit";

export const credentials = createCredentialStore({
  dirName: ".deviceyard",
  tokenEnvVar: "DEVICEYARD_API_KEY",
  // The MCP client shipped first and CI is already setting MOBILE_FARM_TOKEN.
  // Accepting it costs one line and saves every existing pipeline an edit.
  fallbackTokenEnvVar: "MOBILE_FARM_TOKEN",
  missingHint:
    "Run `deviceyard login` to store a personal access token, or set DEVICEYARD_API_KEY " +
    "to an org token (that is what CI should use).",
});

export interface Resolved {
  farmUrl: string;
  timeoutMs: number;
  token: string;
  kind: "org" | "personal";
  orgId?: number;
}

export function resolveConnection(
  opts: { apiKey?: string; url?: string; org?: number },
  env: NodeJS.ProcessEnv,
  homeDir?: string,
  gate: { requireOrg?: boolean } = {},
): Resolved {
  // --url beats the environment. Injected as DEVICEYARD_URL rather than
  // handled separately, so the URL goes through exactly one validator and one
  // normaliser however it arrived.
  const merged = opts.url ? { ...env, DEVICEYARD_URL: opts.url } : env;

  let config;
  try {
    config = loadFarmConfig(merged, {
      urlVar: "DEVICEYARD_URL",
      timeoutVar: "DEVICEYARD_TIMEOUT_MS",
      fallbackUrlVar: "MOBILE_FARM_URL",
    });
  } catch (err) {
    throw new CliError(
      `${err instanceof Error ? err.message : String(err)} - pass --url https://your-farm, ` +
      `or set DEVICEYARD_URL.`,
    );
  }

  let cred;
  if (opts.apiKey) {
    cred = { token: opts.apiKey.trim(), kind: "org" as const };
  } else {
    try {
      cred = credentials.loadCredential(config.farmUrl, env, homeDir);
    } catch (err) {
      throw new CliError(err instanceof Error ? err.message : String(err));
    }
  }

  // A personal access token carries no org, so the server needs X-Org-Id.
  // Fail here naming the FLAG rather than let the farm answer 403 with a
  // message about a header the user never typed and cannot set.
  if (gate.requireOrg && cred.kind === "personal" && opts.org === undefined) {
    throw new CliError(
      "this credential is a personal access token, which belongs to a person rather than an " +
      "org - name the org with --org <id>. `deviceyard whoami` lists the orgs you belong to.",
    );
  }

  return {
    farmUrl: normaliseFarmUrl(config.farmUrl),
    timeoutMs: config.timeoutMs,
    ...cred,
    orgId: opts.org,
  };
}
