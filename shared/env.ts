// Pure env validation, shared by the server (src/env.ts) and the CLI. Nothing
// here persists or masks anything: the masking constants and helpers stay
// server-side, because only the server writes text to disk.

/** Device Cloud's convention, adopted deliberately so a team moving between
 * that service and this one gets the same behaviour without relearning it:
 * "Name secret-bearing variables with a keyword like PASSWORD, TOKEN, SECRET,
 * or API_KEY so their values are automatically masked in logs and artifacts."
 *
 * Also includes APIKEY (no underscore) because the spelling without underscore is
 * common enough to be a real footgun — an unmasked credential is worse than a
 * small divergence from the published convention. Both API_KEY and APIKEY are
 * needed since neither substring matches the other.
 */
const SECRET_MARKERS = ["PASSWORD", "TOKEN", "SECRET", "API_KEY", "APIKEY"];

/** A secret value this short would match half the artifact and shred it, so
 * it is rejected at validation rather than masked. */
const MIN_SECRET_VALUE_LENGTH = 4;

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class EnvValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvValidationError";
  }
}

export function isSecretKey(key: string): boolean {
  const upper = key.toUpperCase();
  return SECRET_MARKERS.some((marker) => upper.includes(marker));
}

/**
 * Multipart cannot carry nested objects, so `env` arrives JSON-encoded exactly
 * like the `flows` field beside it.
 *
 * Returns undefined when the field is absent. Absent is NOT the same as `{}`:
 * an absent field must produce a byte-identical argument list to before this
 * feature existed, which is what DonableApp's CI depends on.
 *
 * Every message names the offending key. A future drop-in CLI surfaces these
 * verbatim, so "invalid env" would leave a user with nothing to act on.
 */
export function parseEnvField(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") throw new EnvValidationError("env must be a JSON-encoded object");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EnvValidationError("env is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new EnvValidationError("env must be a JSON object of string values");
  }

  const out: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!KEY_PATTERN.test(key)) {
      throw new EnvValidationError(`env key ${JSON.stringify(key)} is not a valid identifier`);
    }
    if (typeof value !== "string") {
      throw new EnvValidationError(`env value for ${key} must be a string`);
    }
    // A key containing "=" would silently redefine what Maestro parses, and a
    // newline would corrupt the debug files the masking step later scans.
    // Rejected rather than escaped: there is no shell here (execFile takes an
    // argument array), so escaping would buy nothing and hide the mistake.
    if (value.includes("\n") || value.includes("\r") || value.includes("\0")) {
      throw new EnvValidationError(`env value for ${key} must not contain a newline or NUL`);
    }
    if (isSecretKey(key) && value.length < MIN_SECRET_VALUE_LENGTH) {
      throw new EnvValidationError(
        `env value for ${key} is too short to mask safely (minimum ${MIN_SECRET_VALUE_LENGTH} characters)`,
      );
    }
    out[key] = value;
  }
  return out;
}
