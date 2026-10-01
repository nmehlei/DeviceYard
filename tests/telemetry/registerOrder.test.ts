import fs from "fs";
import path from "path";

/**
 * instrumentation-http patches the http module at require time. If express is
 * required before the SDK starts, HTTP spans silently never appear - the
 * service looks healthy and reports nothing. This test is the guard for that,
 * because an auto-import-sorter will move the line without comment.
 */
test("the telemetry register module is the first import in src/index.ts", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "index.ts"), "utf8");
  const firstImport = source
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("import "));

  expect(firstImport).toBe('import "./telemetry/register";');
});
