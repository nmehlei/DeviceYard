import { parseEnvField, EnvValidationError } from "../../shared/env";
import { CliError } from "./exit";

/** Turns repeated `--env KEY=VALUE` flags into the single JSON object
 * POST /run takes, validated with the SERVER'S OWN rules (shared/env.ts) so a
 * typo fails here rather than after a 512 MB upload.
 *
 * The server still validates on receipt; this is a fast path, not a security
 * boundary. Running the server's own parser rather than reimplementing its
 * rules is what makes "the CLI surfaces these messages verbatim" true instead
 * of aspirational. */
export function parseEnvPairs(pairs: string[]): Record<string, string> | undefined {
  if (pairs.length === 0) return undefined;

  const obj: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new CliError(`--env "${pair}" must be KEY=VALUE`);
    obj[pair.slice(0, eq)] = pair.slice(eq + 1);
  }

  try {
    return parseEnvField(JSON.stringify(obj));
  } catch (err) {
    if (err instanceof EnvValidationError) throw new CliError(err.message);
    throw err;
  }
}
