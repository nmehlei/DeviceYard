import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { openDatabase, type Db } from "../../src/db/driver";
import { migrate } from "../../src/db/migrations";
import { JobRepository } from "../../src/store/jobRepository";
import type { runJob } from "../../src/jobRunner";
import { defaultRunner, type CommandRunner } from "../../src/maestro";

const DEVICE = "emulator-5554";
const APP_ID = "net.donable.app.testing";

export type JobOptions = Parameters<typeof runJob>[0];

/**
 * Self-contained fixture for driving runJob in a test.
 *
 * tests/jobRunner.test.ts builds the same shape from beforeEach closure
 * state; this exists separately rather than refactoring that suite, which is
 * large, passing, and not what the telemetry work is entitled to destabilise.
 * If a third caller appears, that suite should adopt this and the duplication
 * should go.
 */
export interface JobHarness {
  options: JobOptions;
  repo: JobRepository;
  cleanup: () => void;
}

/** No device is attached in a test sandbox, so every external command is
 * faked. `tar` alone is real - the extraction step must actually produce
 * files for the flow steps to find. */
function harnessRunner(failFlow: boolean): CommandRunner {
  return async (file, args) => {
    if (file === "tar") return defaultRunner(file, args);
    if (args.includes("devices")) {
      return { code: 0, stdout: `List of devices attached\n${DEVICE}\tdevice\n`, stderr: "" };
    }
    if (failFlow && file.includes("maestro")) {
      return { code: 1, stdout: "", stderr: "flow failed" };
    }
    return { code: 0, stdout: "ok", stderr: "" };
  };
}

export function makeJobHarness(opts: {
  flows: string[];
  env?: Record<string, string>;
  failFlow?: boolean;
}): JobHarness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-spans-"));
  const dataDir = path.join(dir, "data");
  const db: Db = openDatabase(path.join(dataDir, "farm.db"));
  migrate(db);
  const repo = new JobRepository(db);

  const srcDir = path.join(dir, "src");
  for (const flow of opts.flows) {
    const file = path.join(srcDir, "e2e", "scenarios", `${flow}.yaml`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "appId: test\n---\n- launchApp\n");
  }
  const archivePath = path.join(dir, "flows.tar.gz");
  execFileSync("tar", ["-czf", archivePath, "-C", srcDir, "e2e"]);

  const apkPath = path.join(dir, "app.apk");
  fs.writeFileSync(apkPath, "not-an-apk");
  const extractDir = fs.mkdtempSync(path.join(dir, "extract-"));

  const job = repo.createJob("donable", opts.flows);

  return {
    repo,
    options: {
      jobId: job.id,
      deviceId: DEVICE,
      appId: APP_ID,
      dataDir,
      apkPath,
      flowsArchivePath: archivePath,
      extractDir,
      repo,
      runner: harnessRunner(opts.failFlow ?? false),
      captureScreenshot: async () => Buffer.from("fake-screenshot-bytes"),
      env: opts.env,
    },
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
