/** src/mcp/ is a NETWORK client of the farm API. If it ever imports the
 * database, the store, or the express app, it stops being testable off the
 * device and becomes a second, unreviewed way to mutate job state. This
 * scanner is the enforcement; the rule alone was not going to hold.
 *
 * Four import forms all need catching, since any one of them is a real
 * bypass if only "from ..." is matched: a static named/default import
 * (`import x from "..."` / `export ... from "..."`), a bare side-effect
 * import (`import "...";`), a CommonJS call (`require("...")`), and a
 * dynamic import (`await import("...")`). */
export const FORBIDDEN = ["../server", "../db/", "../store/", "../jobRunner", "../queue", "../retention", "express", "better-sqlite3"];

/** shared/ has the same rule for a second reason. It is consumed by cli/,
 * which is published to npm: anything shared/ imports from src/ would be
 * dragged into a public package, and the "extraction to a public repo is a
 * directory move" property would quietly stop being true. Expressed as
 * "nothing from src/ at all" rather than a list of module names, because the
 * point is the directory boundary, not any particular module. */
export const FORBIDDEN_FROM_SHARED = ["../src/", "./src/", "express", "better-sqlite3"];

const SPECIFIER_PATTERNS = [
  /from\s+["']([^"']+)["']/g,
  /\bimport\s+["']([^"']+)["']/g,
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
];

/** Returns every forbidden module specifier referenced by `source`, in any
 * of the four forms above. Deduplicated but not otherwise ordered. */
export function findForbiddenImports(source: string, forbidden: string[] = FORBIDDEN): string[] {
  const specs = new Set<string>();
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      specs.add(match[1]);
    }
  }
  return [...specs].filter((spec) => forbidden.some((f) => spec === f || spec.startsWith(f)));
}
