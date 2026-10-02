import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { openDatabase } from "../src/db/driver";
import { migrate } from "../src/db/migrations";
import { JobRepository } from "../src/store/jobRepository";
import { REDACTED } from "../src/env";
import { defaultRunner, type CommandRunner } from "../src/maestro";
import { runJob } from "../src/jobRunner";

const TEST_DEVICE_ID = "emulator-5554";
const TEST_APP_ID = "net.donable.app.testing";
const FLOW_NAME = "map/map";

function devicesReply() {
  return { code: 0, stdout: `List of devices attached\n${TEST_DEVICE_ID}\tdevice\n`, stderr: "" };
}

describe("runJob with env", () => {
  let dataDir: string;
  let uploadDir: string;
  let apkPath: string;
  let flowsArchivePath: string;
  let extractDir: string;
  let repo: JobRepository;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-jobrunner-env-data-"));
    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-jobrunner-env-upload-"));
    extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-jobrunner-env-extract-"));

    apkPath = path.join(uploadDir, "app.apk");
    fs.writeFileSync(apkPath, Buffer.from("fake apk bytes"));

    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdf-jobrunner-env-src-"));
    const scenariosDir = path.join(srcDir, "e2e", "scenarios", "map");
    fs.mkdirSync(scenariosDir, { recursive: true });
    fs.writeFileSync(path.join(scenariosDir, "map.yaml"), "appId: test\n---\n- launchApp\n");
    flowsArchivePath = path.join(uploadDir, "flows.tar.gz");
    execFileSync("tar", ["-czf", flowsArchivePath, "-C", srcDir, "e2e"]);
    fs.rmSync(srcDir, { recursive: true, force: true });

    const db = openDatabase(path.join(dataDir, "farm.db"));
    migrate(db);
    repo = new JobRepository(db);
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(uploadDir, { recursive: true, force: true });
    fs.rmSync(extractDir, { recursive: true, force: true });
  });

  it("passes -e to maestro and masks the secret out of the stored preview", async () => {
    const env = { E2E_LAUNCHER: "samsung", E2E_TEST_PASSWORD: "hunter2222" };
    const job = repo.createJob("donable", [FLOW_NAME], env);

    const maestroArgs: string[][] = [];
    const runner: CommandRunner = async (file, args) => {
      if (file === "tar") return defaultRunner(file, args);
      if (args.includes("devices")) return devicesReply();
      if (file === "maestro" && args.includes("test")) {
        maestroArgs.push(args);
        return { code: 0, stdout: "saw hunter2222 and samsung", stderr: "" };
      }
      return { code: 0, stdout: "ok", stderr: "" };
    };

    await runJob({
      jobId: job.id,
      deviceId: TEST_DEVICE_ID,
      appId: TEST_APP_ID,
      dataDir,
      apkPath,
      flowsArchivePath,
      extractDir,
      repo,
      runner,
      env,
    });

    expect(maestroArgs).toHaveLength(1);
    expect(maestroArgs[0]).toContain("-e");
    expect(maestroArgs[0]).toContain("E2E_TEST_PASSWORD=hunter2222");

    const flowStep = repo.getSteps(job.id).find((s) => s.kind === "flow");
    expect(flowStep).toBeDefined();
    expect(flowStep!.stdoutPreview).toContain(REDACTED);
    expect(flowStep!.stdoutPreview).toContain("samsung");
    expect(flowStep!.stdoutPreview).not.toContain("hunter2222");
  });
});
