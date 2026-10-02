import type { JobDetail } from "../../../shared/apiTypes";

export interface RunJson {
  jobId: string;
  farmUrl: string;
  status: string;
  flows: Array<{ name: string; status: string; durationMs: number | null }>;
}

/** A shape the CLI OWNS, deliberately not a passthrough of GET /api/jobs/:id.
 * --json-file output is a contract with someone's pipeline; if it mirrored the
 * dashboard API, every field that API grows would leak into it - and the
 * dashboard API is explicitly free to evolve (docs/guide/api-reference.md).
 *
 * Setup steps are excluded for the same reason renderJUnit excludes them: a
 * consumer counting flows must not count <install>. */
export function renderRunJson(jobId: string, farmUrl: string, detail: JobDetail): string {
  const payload: RunJson = {
    jobId,
    farmUrl,
    status: detail.job.status,
    flows: detail.steps
      .filter((s) => s.kind === "flow")
      .map((s) => ({
        name: s.name,
        status: s.status,
        // null, not 0: "never started" and "took no time" are different facts,
        // and a consumer averaging durations must be able to tell them apart.
        durationMs:
          s.startedAt !== null && s.finishedAt !== null ? s.finishedAt - s.startedAt : null,
      })),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}
