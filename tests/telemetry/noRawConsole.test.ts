import fs from "fs";
import path from "path";

/**
 * Once the logger exists, a raw console.* call is a log line with no
 * trace_id, invisible to the backend and uncorrelated in journald. This test
 * is what stops the migration silently regressing one file at a time.
 */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

test("no source file outside the telemetry module calls console directly", () => {
  const srcDir = path.join(__dirname, "..", "..", "src");
  const offenders: string[] = [];

  for (const file of walk(srcDir)) {
    // log.ts is the one place allowed to call console - it IS the stdout sink.
    if (file.endsWith(path.join("src", "telemetry", "log.ts"))) continue;
    // The MCP server is out of scope for this phase and writes to stdio by
    // protocol, not for logging.
    if (file.includes(`${path.sep}mcp${path.sep}`)) continue;

    const source = fs.readFileSync(file, "utf8");
    for (const [i, line] of source.split("\n").entries()) {
      if (/(^|[^.\w])console\.(log|warn|error)\s*\(/.test(line) && !line.trim().startsWith("//")) {
        offenders.push(`${path.relative(srcDir, file)}:${i + 1}`);
      }
    }
  }

  expect(offenders).toEqual([]);
});
