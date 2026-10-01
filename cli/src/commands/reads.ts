import fs from "fs";
import path from "path";
import type { FarmClient } from "../../../shared/client";
import type { JobDetail, JobListResponse, StepRow } from "../../../shared/apiTypes";
import type { Io } from "../main";
import { EXIT_ERROR, EXIT_FLOW_FAILED, EXIT_OK } from "../exit";

/** The same verdict rule `cloud` applies: a job that failed before producing
 * any flow verdict is infrastructure (exit 1), not a test failure (exit 2).
 * Both commands call this rather than each having its own copy - duplicating
 * it is how the two would start disagreeing about what a failure means. */
export function verdict(detail: JobDetail, io: Io): number {
  const flows = (detail.steps ?? []).filter((s) => s.kind === "flow");
  if (detail.job.status === "failed" && flows.length === 0) {
    io.err(detail.job.error ?? "the job failed before any flow ran");
    return EXIT_ERROR;
  }
  return flows.some((s) => s.status === "failed") ? EXIT_FLOW_FAILED : EXIT_OK;
}

export async function runStatus(jobId: string, client: FarmClient, io: Io): Promise<number> {
  const detail = await client.getJson<JobDetail>(`/api/jobs/${encodeURIComponent(jobId)}`);
  io.out(`job ${detail.job.id}: ${detail.job.status}`);
  for (const s of detail.steps ?? []) {
    const mark = s.status === "passed" ? "PASS" : s.status === "failed" ? "FAIL" : "....";
    io.out(`  ${mark}  ${s.kind === "setup" ? "[setup] " : ""}${s.name} - ${s.status}`);
  }
  return verdict(detail, io);
}

export async function runList(limit: number, client: FarmClient, io: Io): Promise<number> {
  const { jobs } = await client.getJson<JobListResponse>(`/api/jobs?limit=${limit}`);
  if (jobs.length === 0) {
    io.out("no jobs");
    return EXIT_OK;
  }
  for (const j of jobs) {
    io.out(
      `${j.id}  ${j.status.padEnd(8)}  ${j.passed}/${j.flowCount} passed  ` +
      `${new Date(j.createdAt).toISOString()}`,
    );
  }
  return EXIT_OK;
}

/** A step name is a flow id like "map/filter", so it contains path
 * separators. Flattening them keeps the output one level deep and - more to
 * the point - means a name coming off the wire can never escape outPath. */
const safeDir = (name: string): string => name.replace(/[^A-Za-z0-9._-]+/g, "_");

export async function runArtifacts(
  jobId: string,
  which: "ALL" | "FAILED",
  outPath: string,
  client: FarmClient,
  io: Io,
): Promise<number> {
  const detail = await client.getJson<JobDetail>(`/api/jobs/${encodeURIComponent(jobId)}`);
  const steps: StepRow[] =
    which === "FAILED"
      ? (detail.steps ?? []).filter((s) => s.status === "failed")
      : (detail.steps ?? []);

  const planned = steps.flatMap((s) => (s.artifacts ?? []).map((a) => ({ step: s, artifact: a })));

  if (planned.length === 0) {
    io.err(
      `no artifacts to download for job ${jobId}` +
      (which === "FAILED" ? " (no failed steps, or they produced none)" : "") +
      `. Artifacts are subject to retention - see docs/guide/artifacts-and-retention.md.`,
    );
    return EXIT_ERROR;
  }

  for (const { step, artifact } of planned) {
    const dest = path.join(outPath, safeDir(step.name), artifact.relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const body = await client.getBinary(`/api/artifacts/${artifact.id}`);
    fs.writeFileSync(dest, body.bytes);
  }

  io.out(`downloaded ${planned.length} artifact(s) to ${outPath}`);
  return EXIT_OK;
}
