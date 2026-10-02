import type { CommandRunner } from "./maestro";
import { defaultRunner } from "./maestro";

export interface ExtractResult {
  passed: boolean;
  stdout: string;
  stderr: string;
}

export async function extractArchive(
  archivePath: string,
  destDir: string,
  runner: CommandRunner = defaultRunner
): Promise<ExtractResult> {
  const { code, stdout, stderr } = await runner("tar", ["-xzf", archivePath, "-C", destDir]);
  return { passed: code === 0, stdout, stderr };
}
