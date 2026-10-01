// Visibility, not policy: retention is deliberately unimplemented (see
// docs/open_issues.md). These thresholds make the existing artifactBytes
// number noticeable on the device ops page rather than just queryable.
// Sized against the farm host's actual disk (15GB total, 12GB free,
// checked via `df -h` during design) - revisit if that host changes.
export const AMBER_BYTES = 2 * 1024 ** 3;
export const RED_BYTES = 5 * 1024 ** 3;

export function artifactLevel(bytes: number): "ok" | "amber" | "red" {
  if (bytes >= RED_BYTES) return "red";
  if (bytes >= AMBER_BYTES) return "amber";
  return "ok";
}
