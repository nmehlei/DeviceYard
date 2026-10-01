import fs from "fs";
import os from "os";
import path from "path";
import { classify, collectArtifacts } from "../../src/artifacts/collector";

let dataDir: string;
let debugDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-art-data-"));
  debugDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-art-debug-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(debugDir, { recursive: true, force: true });
});

test("classify maps maestro output names to artifact kinds", () => {
  expect(classify("screenshot-(failed)-1.png")).toBe("screenshot");
  expect(classify("recording.mp4")).toBe("recording");
  expect(classify("hierarchy.json")).toBe("hierarchy");
  expect(classify("notes.txt")).toBeUndefined();
});

// Maestro 2.6.1 writes maestro.log alongside its screenshots/commands JSON in
// the debug directory. It is the single most useful artifact when diagnosing
// a failed flow, so classify() must not silently drop it the way the
// original brief's mapping did.
test("classify maps maestro.log to the log kind", () => {
  expect(classify("maestro.log")).toBe("log");
});

test("stdout and stderr are always written, even with no debug directory", async () => {
  const result = await collectArtifacts({ dataDir, relDir: "j1/3", stdout: "hello", stderr: "" });

  const kinds = result.artifacts.map((a) => a.kind).sort();
  expect(kinds).toEqual(["stderr", "stdout"]);
  expect(result.warnings).toEqual([]);

  const stdout = result.artifacts.find((a) => a.kind === "stdout")!;
  expect(fs.readFileSync(path.join(dataDir, "artifacts", stdout.relPath), "utf8")).toBe("hello");
  expect(stdout.bytes).toBe(5);
});

test("maestro debug output is copied and classified", async () => {
  fs.writeFileSync(path.join(debugDir, "screenshot-(failed)-1.png"), "png-bytes");
  fs.writeFileSync(path.join(debugDir, "hierarchy.json"), "{}");
  fs.writeFileSync(path.join(debugDir, "ignored.log"), "noise");

  const result = await collectArtifacts({ dataDir, relDir: "j1/3", debugDir, stdout: "", stderr: "" });

  const kinds = result.artifacts.map((a) => a.kind).sort();
  // "ignored.log" is no longer ignored: maestro.log-style files now classify
  // as "log", so the debug directory's *.log file is collected too.
  expect(kinds).toEqual(["hierarchy", "log", "screenshot", "stderr", "stdout"]);
  expect(fs.existsSync(path.join(dataDir, "artifacts", "j1", "3", "screenshot-(failed)-1.png"))).toBe(true);
});

test("a real maestro.log in the debug directory is collected with kind log", () => {
  return (async () => {
    fs.writeFileSync(path.join(debugDir, "maestro.log"), "flow started\nflow failed: element not found\n");

    const result = await collectArtifacts({ dataDir, relDir: "j1/3", debugDir, stdout: "", stderr: "" });

    const log = result.artifacts.find((a) => a.kind === "log");
    expect(log).toBeDefined();
    expect(fs.readFileSync(path.join(dataDir, "artifacts", log!.relPath), "utf8")).toContain(
      "flow failed: element not found"
    );
  })();
});

test("a missing debug directory is a warning, never a failure", async () => {
  const result = await collectArtifacts({
    dataDir,
    relDir: "j1/3",
    debugDir: path.join(debugDir, "does-not-exist"),
    stdout: "",
    stderr: "",
  });

  // A failed screenshot must never turn a passing flow red.
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings[0]).toContain("does-not-exist");
  expect(result.artifacts.map((a) => a.kind).sort()).toEqual(["stderr", "stdout"]);
});

test("an unwritable data directory degrades to warnings instead of throwing", async () => {
  const readOnly = path.join(dataDir, "ro");
  fs.mkdirSync(readOnly);
  fs.chmodSync(readOnly, 0o500);

  const result = await collectArtifacts({ dataDir: readOnly, relDir: "j1/3", stdout: "x", stderr: "" });

  expect(result.artifacts).toEqual([]);
  expect(result.warnings.length).toBeGreaterThan(0);

  fs.chmodSync(readOnly, 0o700);
});

test("nested debug output is flattened with its parent directory in the name", async () => {
  const nested = path.join(debugDir, "0");
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, "screenshot-1.png"), "x");

  const result = await collectArtifacts({ dataDir, relDir: "j1/3", debugDir, stdout: "", stderr: "" });

  expect(result.artifacts.some((a) => a.kind === "screenshot" && a.relPath.includes("0-screenshot-1.png"))).toBe(
    true
  );
});
