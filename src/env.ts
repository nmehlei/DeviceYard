/** What a secret value is replaced with wherever this farm persists text. */
export const REDACTED = "***REDACTED***";

// The pure validators live in shared/env.ts so the CLI can pre-validate --env
// with the SERVER'S OWN rules — a typo then fails before a 512 MB upload
// rather than after it, and one implementation means the two can never
// disagree. That is exactly what parseEnvField's "A future drop-in CLI
// surfaces these verbatim" note was anticipating. Everything below is
// server-side only: it persists text, which the CLI never does.
import { isSecretKey } from "../shared/env";
export { EnvValidationError, isSecretKey, parseEnvField } from "../shared/env";

/** What gets written to the job record: keys and non-secret values survive so
 * "why did this run behave differently" stays answerable; secret values do
 * not reach the database at all. */
export function maskEnvForStorage(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(env)) {
    out[key] = isSecretKey(key) ? REDACTED : value;
  }
  return out;
}

/** `&` must come first: escaping it after `<`/`>`/etc. would re-escape the
 * ampersands those substitutions just introduced. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Redacts secret values out of text this farm is about to persist.
 *
 * Three forms of each value are replaced. The raw one is obvious. The second
 * exists because Maestro writes every -e value into commands-*.json in its
 * debug-output directory (mobile-dev-inc/Maestro#2512, open and unfixed), and
 * JSON escapes quotes and backslashes - so a password containing either
 * appears there in a form a literal match walks straight past. The third
 * exists because `classify()` maps `.xml` to `hierarchy`, which is also
 * masked - a value typed into a field can land in an XML hierarchy dump with
 * `&`, `<`, `>`, `"`, `'` entity-escaped, past a literal match again.
 *
 * All forms across all secret values are replaced longest-first, not
 * per-value in caller-supplied key order: if one secret value is a substring
 * of another and the shorter one were replaced first, the longer value would
 * be left partially masked - a suffix of a live credential surviving into
 * stored text.
 *
 * This is substring replacement, so a value the flow *transforms* (base64,
 * URL-encoding, truncation) is not caught. The guarantee is "the value as
 * supplied does not appear in stored text", not "no derivative can leak".
 */
export function maskSecrets(text: string, env: Record<string, string> | undefined): string {
  if (!env) return text;
  const forms = Object.entries(env)
    .filter(([key, value]) => isSecretKey(key) && value)
    .flatMap(([, value]) => [value, JSON.stringify(value).slice(1, -1), xmlEscape(value)]);

  let out = text;
  for (const form of [...new Set(forms)].sort((a, b) => b.length - a.length)) {
    out = out.split(form).join(REDACTED);
  }
  return out;
}
