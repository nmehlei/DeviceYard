import fs from "fs";
import os from "os";
import path from "path";
import { collectArtifacts } from "../../src/artifacts/collector";
import { REDACTED } from "../../src/env";

const ENV = { E2E_LAUNCHER: "samsung", E2E_TEST_PASSWORD: "hunter2222" };

let root: string;
let debugDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "collect-env-"));
  debugDir = path.join(root, "debug");
  fs.mkdirSync(debugDir, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const read = (rel: string) => fs.readFileSync(path.join(root, "artifacts", rel), "utf8");

describe("collectArtifacts masking", () => {
  it("redacts a secret from stdout.log and stderr.log but keeps non-secrets", async () => {
    await collectArtifacts({
      dataDir: root, relDir: "job/0",
      stdout: "launcher=samsung pw=hunter2222", stderr: "pw=hunter2222", env: ENV,
    });
    expect(read("job/0/stdout.log")).toBe(`launcher=samsung pw=${REDACTED}`);
    expect(read("job/0/stderr.log")).toBe(`pw=${REDACTED}`);
  });

  // The upstream leak this whole cycle defends against: Maestro writes -e
  // values verbatim into commands-*.json inside --debug-output.
  it("redacts a secret from a commands-*.json copied out of the debug directory", async () => {
    fs.writeFileSync(
      path.join(debugDir, "commands-abc.json"),
      JSON.stringify({ env: { E2E_TEST_PASSWORD: "hunter2222", E2E_LAUNCHER: "samsung" } }),
    );
    await collectArtifacts({ dataDir: root, relDir: "job/1", debugDir, stdout: "", stderr: "", env: ENV });
    const copied = read("job/1/commands-abc.json");
    expect(copied).not.toContain("hunter2222");
    expect(copied).toContain(REDACTED);
    expect(copied).toContain("samsung");
  });

  it("redacts a secret from maestro.log", async () => {
    fs.writeFileSync(path.join(debugDir, "maestro.log"), "using hunter2222 now");
    await collectArtifacts({ dataDir: root, relDir: "job/2", debugDir, stdout: "", stderr: "", env: ENV });
    expect(read("job/2/maestro.log")).toBe(`using ${REDACTED} now`);
  });

  it("leaves a binary artifact byte-identical", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
    fs.writeFileSync(path.join(debugDir, "shot.png"), png);
    await collectArtifacts({ dataDir: root, relDir: "job/3", debugDir, stdout: "", stderr: "", env: ENV });
    expect(fs.readFileSync(path.join(root, "artifacts", "job/3/shot.png"))).toEqual(png);
  });

  it("changes nothing when no env is supplied", async () => {
    fs.writeFileSync(path.join(debugDir, "maestro.log"), "hunter2222 stays");
    await collectArtifacts({ dataDir: root, relDir: "job/4", debugDir, stdout: "hunter2222", stderr: "" });
    expect(read("job/4/maestro.log")).toBe("hunter2222 stays");
    expect(read("job/4/stdout.log")).toBe("hunter2222");
  });

  // maestro.log carries device/app output with no UTF-8 guarantee. A job
  // that supplies env with no secret keys must still get a byte-exact copy,
  // not a read("utf8")+write round trip that silently replaces any invalid
  // byte with U+FFFD. Verified against the unfixed code (which gates the
  // rewrite on `opts.env` being merely truthy): a source file
  // <41 ff 42> (3 bytes) comes back as <41 ef bf bd 42> (5 bytes).
  it("leaves a maestro.log with a non-UTF-8 byte untouched when env has no secret keys", async () => {
    const raw = Buffer.from([0x41, 0xff, 0x42]);
    fs.writeFileSync(path.join(debugDir, "maestro.log"), raw);
    await collectArtifacts({
      dataDir: root, relDir: "job/6", debugDir, stdout: "", stderr: "",
      env: { E2E_LAUNCHER: "samsung" },
    });
    expect(fs.readFileSync(path.join(root, "artifacts", "job/6/maestro.log"))).toEqual(raw);
  });

  it("reports the masked byte length, not the original", async () => {
    const result = await collectArtifacts({
      dataDir: root, relDir: "job/5", stdout: "hunter2222", stderr: "", env: ENV,
    });
    const stdoutArtifact = result.artifacts.find((a) => a.kind === "stdout")!;
    expect(stdoutArtifact.bytes).toBe(Buffer.byteLength(REDACTED));
  });
});
