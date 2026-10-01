/** Configuration for a farm client. Environment only - the same bundled
 * file has to work unchanged under Claude Code, Codex, a CI runner or
 * anything else that can set env vars on a child process, so there is no
 * config file format to keep in sync. */
export interface FarmEnvConfig {
  farmUrl: string;
  timeoutMs: number;
}

/** The full shape createFarmClient needs. loadFarmConfig alone cannot
 * produce this: the token comes from a CredentialStore (an org token from
 * the environment, or a personal one from the credentials file), and each
 * consumer's entrypoint is what composes the two. */
export interface FarmClientConfig extends FarmEnvConfig {
  token: string;
}

export const DEFAULT_TIMEOUT_MS = 900000;

/** Store the NORMALISED origin+path, never the raw string. A user who pasted
 * the whole `https://farm/?token=...` status URL would otherwise have that
 * credential concatenated into every request URL and into user-facing links,
 * neither of which goes through safeUrl. Rebuilding from the parsed URL drops
 * the query and the fragment by construction rather than by pattern-matching
 * for them.
 *
 * Farm URLs are also the credential file's keys, so they must normalise
 * identically however the user typed them - which is why this lives here and
 * credentials.ts calls it rather than keeping its own copy. */
export function normaliseFarmUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

/** Deliberately does NOT require a token: a personal-access-token user has no
 * token env var at all - their credential lives in the credentials file - and
 * throwing here before the CredentialStore ever runs would report exactly the
 * opposite of the truth. The token is resolved separately.
 *
 * The variable NAMES are parameters because there are now two consumers with
 * two prefixes (MOBILE_FARM_* for the MCP client, DEVICEYARD_* for the CLI),
 * and every error message has to name the variable the caller actually set. */
export function loadFarmConfig(
  env: NodeJS.ProcessEnv,
  vars: { urlVar: string; timeoutVar: string; fallbackUrlVar?: string },
): FarmEnvConfig {
  const raw =
    env[vars.urlVar]?.trim() ||
    (vars.fallbackUrlVar ? env[vars.fallbackUrlVar]?.trim() : undefined);

  if (!raw) throw new Error(`${vars.urlVar} is required`);

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // Deliberately does not echo raw: a user who pasted the whole
    // ?token=... status URL in here would otherwise have their token printed
    // back at them by the very check meant to protect it.
    throw new Error(`${vars.urlVar} is not a valid URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${vars.urlVar} must be an http(s) URL`);
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  const rawTimeout = env[vars.timeoutVar];
  if (rawTimeout !== undefined && rawTimeout.trim() !== "") {
    timeoutMs = Number(rawTimeout);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`${vars.timeoutVar} must be a positive number of milliseconds`);
    }
  }

  return { farmUrl: normaliseFarmUrl(raw), timeoutMs };
}

/** The server accepts `?token=` as a browser fallback, so any URL this
 * process echoes could carry a live credential. Every diagnostic path goes
 * through here rather than trusting the caller to have built a clean URL. */
export function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<unparseable url>";
  }
}

/** Last line of defence for text that came from somewhere else (an upstream
 * error, a response body) and might have echoed the credential back. */
export function redactToken(text: string, token: string): string {
  if (!token) return text;
  return text.split(token).join("<redacted>");
}
