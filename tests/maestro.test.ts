import { runMaestroFlow, getMaestroVersion, versionCheckRunner, defaultRunner, createRunner, type CommandRunner } from "../src/maestro";

test("passed is true when the command exits 0", async () => {
  const fakeRunner: CommandRunner = async () => ({
    code: 0,
    stdout: "All flows passed",
    stderr: "",
  });

  const result = await runMaestroFlow("emulator-5554", "e2e/scenarios/map/map.yaml", fakeRunner);

  expect(result).toEqual({
    flow: "e2e/scenarios/map/map.yaml",
    passed: true,
    stdout: "All flows passed",
    stderr: "",
  });
});

test("passed is false when the command exits non-zero", async () => {
  const fakeRunner: CommandRunner = async () => ({
    code: 1,
    stdout: "",
    stderr: "assertion failed",
  });

  const result = await runMaestroFlow("emulator-5554", "e2e/scenarios/map/map.yaml", fakeRunner);

  expect(result.passed).toBe(false);
  expect(result.stderr).toBe("assertion failed");
});

test("invokes maestro with --device and test subcommand", async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const fakeRunner: CommandRunner = async (file, args) => {
    calls.push({ file, args });
    return { code: 0, stdout: "", stderr: "" };
  };

  await runMaestroFlow("emulator-5554", "e2e/scenarios/profile/profile.yaml", fakeRunner);

  expect(calls).toEqual([
    {
      file: "maestro",
      args: ["--device", "emulator-5554", "test", "e2e/scenarios/profile/profile.yaml"],
    },
  ]);
});

test("defaultRunner reports code 1 and surfaces the spawn error message when the binary is not on PATH", async () => {
  const result = await defaultRunner("definitely-not-a-real-binary-xyz", ["--version"]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("failed to launch");
  expect(result.stderr).toContain("definitely-not-a-real-binary-xyz");
});

test("a command killed by the runner's timeout is reported as a timeout, not as a launch failure", async () => {
  const result = await createRunner(200)("sleep", ["5"]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain('"sleep" timed out after 0.2s and was killed');
  expect(result.stderr).not.toContain("failed to launch");
});

test("getMaestroVersion returns the trimmed banner maestro --version prints", async () => {
  const fakeRunner: CommandRunner = async () => ({
    code: 0,
    stdout: "Maestro CLI v2.6.1\n",
    stderr: "",
  });

  expect(await getMaestroVersion(fakeRunner)).toBe("Maestro CLI v2.6.1");
});

test("getMaestroVersion invokes maestro --version", async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const fakeRunner: CommandRunner = async (file, args) => {
    calls.push({ file, args });
    return { code: 0, stdout: "2.6.1", stderr: "" };
  };

  await getMaestroVersion(fakeRunner);

  expect(calls).toEqual([{ file: "maestro", args: ["--version"] }]);
});

test("getMaestroVersion reports \"unknown\" on a non-zero exit, e.g. maestro not installed", async () => {
  const fakeRunner: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "command not found" });
  expect(await getMaestroVersion(fakeRunner)).toBe("unknown");
});

test("getMaestroVersion reports \"unknown\" for a successful exit with empty output", async () => {
  const fakeRunner: CommandRunner = async () => ({ code: 0, stdout: "   \n", stderr: "" });
  expect(await getMaestroVersion(fakeRunner)).toBe("unknown");
});

// Regression test for the actual bug: `maestro --version` has a real JVM
// cold-start cost (measured ~4.5s on a dev machine) that routinely exceeded
// api/devices.ts's 5s device-status timeout when getMaestroVersion used to
// share it, reporting "unknown" far more often than not. This exercises the
// REAL default runner (not a fake) against a genuinely slow-but-successful
// command to prove its timeout budget is well past 5s.
test("versionCheckRunner (getMaestroVersion's real default) tolerates a command slower than the old 5s device-status timeout", async () => {
  const result = await versionCheckRunner("sh", ["-c", "sleep 6 && echo slow-but-fine"]);
  expect(result.code).toBe(0);
  expect(result.stdout.trim()).toBe("slow-but-fine");
}, 15_000);

describe("runMaestroFlow with env", () => {
  it("appends -e pairs in sorted key order so argv is deterministic", async () => {
    let seen: string[] = [];
    const runner = async (_file: string, args: string[]) => {
      seen = args;
      return { code: 0, stdout: "", stderr: "" };
    };
    await runMaestroFlow("emulator-5554", "flow.yaml", runner, "/dbg", {
      ZULU: "z", ALPHA: "a", MIKE: "m",
    });
    expect(seen).toEqual([
      "--device", "emulator-5554", "test",
      "--debug-output", "/dbg", "--flatten-debug-output",
      "-e", "ALPHA=a", "-e", "MIKE=m", "-e", "ZULU=z",
      "flow.yaml",
    ]);
  });

  it("produces the pre-existing argument list when env is absent", async () => {
    let seen: string[] = [];
    const runner = async (_file: string, args: string[]) => {
      seen = args;
      return { code: 0, stdout: "", stderr: "" };
    };
    await runMaestroFlow("emulator-5554", "flow.yaml", runner, "/dbg");
    expect(seen).toEqual([
      "--device", "emulator-5554", "test",
      "--debug-output", "/dbg", "--flatten-debug-output", "flow.yaml",
    ]);
  });

  it("produces the pre-existing argument list for an explicitly empty env", async () => {
    let seen: string[] = [];
    const runner = async (_file: string, args: string[]) => {
      seen = args;
      return { code: 0, stdout: "", stderr: "" };
    };
    await runMaestroFlow("emulator-5554", "flow.yaml", runner, "/dbg", {});
    expect(seen).toEqual([
      "--device", "emulator-5554", "test",
      "--debug-output", "/dbg", "--flatten-debug-output", "flow.yaml",
    ]);
  });
});

test("runMaestroFlow uses the given Maestro binary and puts its test args right after \"test\"", async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const fakeRunner: CommandRunner = async (file, args) => {
    calls.push({ file, args });
    return { code: 0, stdout: "", stderr: "" };
  };

  await runMaestroFlow("d", "flow.yaml", fakeRunner, "/dbg", { A: "1" }, {
    file: "/opt/fork/maestro",
    testArgs: ["--android-user", "17"],
  });

  expect(calls).toEqual([
    {
      file: "/opt/fork/maestro",
      args: ["--device", "d", "test", "--android-user", "17", "--debug-output", "/dbg", "--flatten-debug-output", "-e", "A=1", "flow.yaml"],
    },
  ]);
});

test("runMaestroFlow without the override keeps today's exact argument list", async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const fakeRunner: CommandRunner = async (file, args) => {
    calls.push({ file, args });
    return { code: 0, stdout: "", stderr: "" };
  };

  await runMaestroFlow("d", "flow.yaml", fakeRunner, "/dbg", { A: "1" });

  expect(calls).toEqual([
    {
      file: "maestro",
      args: ["--device", "d", "test", "--debug-output", "/dbg", "--flatten-debug-output", "-e", "A=1", "flow.yaml"],
    },
  ]);
});
