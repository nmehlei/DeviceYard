const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 60 * 60 * 1000],
  ["month", 30 * 24 * 60 * 60 * 1000],
  ["week", 7 * 24 * 60 * 60 * 1000],
  ["day", 24 * 60 * 60 * 1000],
  ["hour", 60 * 60 * 1000],
  ["minute", 60 * 1000],
];

const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "2 hours ago", "in 3 minutes", "just now" - built on the standard
 * Intl.RelativeTimeFormat rather than a date library, since this is the
 * only place in the dashboard that needs relative formatting. `now`
 * defaults to Date.now() but is overridable so tests don't race the clock. */
export function formatRelativeTime(timestampMs: number, now: number = Date.now()): string {
  const diffMs = timestampMs - now;
  const absMs = Math.abs(diffMs);

  if (absMs < 60 * 1000) return "just now";

  for (const [unit, unitMs] of UNITS) {
    if (absMs >= unitMs) {
      return formatter.format(Math.round(diffMs / unitMs), unit);
    }
  }
  // Unreachable given the 60s floor above and "minute" being the smallest
  // unit in UNITS, but keeps the function total rather than partial.
  return formatter.format(Math.round(diffMs / (60 * 1000)), "minute");
}
