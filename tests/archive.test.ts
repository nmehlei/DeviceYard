import { extractArchive } from "../src/archive";
import type { CommandRunner } from "../src/maestro";

test("passed is true when the command exits 0", async () => {
  const fakeRunner: CommandRunner = async () => ({
    code: 0,
    stdout: "extracted",
    stderr: "",
  });

  const result = await extractArchive("/tmp/flows.tar.gz", "/tmp/extract-dir", fakeRunner);

  expect(result).toEqual({
    passed: true,
    stdout: "extracted",
    stderr: "",
  });
});

test("passed is false when the command exits non-zero, stderr preserved", async () => {
  const fakeRunner: CommandRunner = async () => ({
    code: 1,
    stdout: "",
    stderr: "tar: unexpected end of file",
  });

  const result = await extractArchive("/tmp/flows.tar.gz", "/tmp/extract-dir", fakeRunner);

  expect(result.passed).toBe(false);
  expect(result.stderr).toBe("tar: unexpected end of file");
});

test("invokes tar with -xzf, the archive path, -C, and the dest dir", async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const fakeRunner: CommandRunner = async (file, args) => {
    calls.push({ file, args });
    return { code: 0, stdout: "", stderr: "" };
  };

  await extractArchive("/tmp/flows.tar.gz", "/tmp/extract-dir", fakeRunner);

  expect(calls).toEqual([
    {
      file: "tar",
      args: ["-xzf", "/tmp/flows.tar.gz", "-C", "/tmp/extract-dir"],
    },
  ]);
});
