import { isSecretKey } from "../../shared/env";
import { REDACTED, maskSecrets } from "../env";

/**
 * Telemetry is a new egress path for data the artifact masker already
 * protects, and it points at a third-party backend. The predicate below is
 * deliberately imported rather than restated: a second copy of the marker
 * list is how the two would come to disagree, and the failure would be
 * silent - a leaked credential in a span nobody re-reads.
 */

/** Header attribute names that carry credentials but contain no secret
 * marker, so isSecretKey alone would pass them through. */
const ALWAYS_REDACTED = ["authorization", "cookie", "set-cookie", "proxy-authorization"];

function isRedactableKey(key: string): boolean {
  if (isSecretKey(key)) return true;
  const lower = key.toLowerCase();
  return ALWAYS_REDACTED.some((name) => lower.endsWith(name));
}

/** Keys survive so "why did this run behave differently" stays answerable;
 * secret values never reach the exporter. Mirrors maskEnvForStorage. */
export function redactAttributes(attrs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    out[key] = isRedactableKey(key) ? REDACTED : value;
  }
  return out;
}

/** For span status messages, exception messages and log bodies, where a
 * secret appears inside free text rather than under a named key. */
export function redactText(text: string, env?: Record<string, string>): string {
  return maskSecrets(text, env);
}
