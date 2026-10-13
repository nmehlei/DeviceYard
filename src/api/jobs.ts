import { Router } from "express";
import { log } from "../telemetry/log";
import type { JobEvents } from "../events";
import type { JobRepository } from "../store/jobRepository";
import type { StepRow } from "../store/rows";

function summarise(steps: StepRow[]) {
  const flows = steps.filter((s) => s.kind === "flow");
  return {
    flowCount: flows.length,
    passed: flows.filter((s) => s.status === "passed").length,
    failed: flows.filter((s) => s.status === "failed").length,
    running: flows.filter((s) => s.status === "running").length,
  };
}

export function jobRoutes(deps: { repo: JobRepository; events: JobEvents; dataDir: string; waitingReason?: (id: string) => string | null }): Router {
  const router = Router();

  // A list view stays cheap even with a lot of history: it summarises each
  // job's progress instead of shipping every step of every job, which is
  // exactly what persistence made possible to accumulate.
  router.get("/api/jobs", (req, res) => {
    // Clamp both ends: without the lower bound, ?limit=-1 hits SQLite's
    // "negative LIMIT means unbounded" behavior and dumps the org's entire
    // history in one response - exactly the cost the summary view exists to
    // avoid.
    const limit = Math.max(1, Math.min(Number(req.query.limit ?? 50) || 50, 200));
    const jobs = deps.repo.listJobs(req.org as string, limit).map((job) => ({
      ...job,
      ...summarise(deps.repo.getSteps(job.id)),
    }));
    res.status(200).json({ jobs });
  });

  const detail = (id: string, org: string) => {
    const job = deps.repo.getJob(id);
    if (!job || job.org !== org) return undefined;
    return {
      job: {...job, waitingReason: job.status === 'queued' ? deps.waitingReason?.(id) ?? null : null},
      steps: deps.repo.getSteps(id).map((step) => ({
        ...step,
        artifacts: deps.repo.getArtifacts(step.id),
      })),
    };
  };

  router.get("/api/jobs/:id", (req, res) => {
    const payload = detail(req.params.id, req.org as string);
    if (!payload) {
      res.status(404).json({ error: "job not found" });
      return;
    }
    res.status(200).json(payload);
  });

  router.get("/api/jobs/:id/events", (req, res) => {
    const org = req.org as string;
    if (!detail(req.params.id, org)) {
      res.status(404).json({ error: "job not found" });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      // Frames here can carry step details for a real job, including
      // artifact rows for screenshots of a logged-in app session - same
      // reasoning as GET /jobs' no-store/Vary: Cookie, plus nosniff.
      "Cache-Control": "no-store",
      Vary: "Cookie",
      "X-Content-Type-Options": "nosniff",
      Connection: "keep-alive",
    });

    // Full state first, increments after: a client joining mid-job never has
    // to reconstruct what it missed.
    const send = (): void => {
      // A publish can arrive after the client disconnected and unsubscribe
      // hasn't run yet (close is async), or after this same send() already
      // ended the response on a terminal status. Writing to a closed
      // response throws - guard instead of relying on timing. `destroyed`
      // covers a socket that died without a clean end (e.g. the client's TCP
      // connection resets) - `writableEnded` alone misses that case, and
      // res.write() on a destroyed-but-not-ended response throws synchronously
      // into JobEvents.publish()'s caller, which is runJob's try block AFTER
      // it has already recorded the job as done.
      if (res.writableEnded || res.destroyed) return;
      const payload = detail(req.params.id, org);
      if (!payload) return;
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      if (payload.job.status === "done" || payload.job.status === "failed") {
        cleanup();
        res.end();
      }
    };

    const unsubscribe = deps.events.subscribe(req.params.id, send);
    // Queue eligibility can change without a job event (device tags, health or license).
    const refresh = deps.waitingReason ? setInterval(() => {
      if (deps.repo.getJob(req.params.id)?.status === 'queued') send();
    }, 10_000) : undefined;
    refresh?.unref?.();
    const cleanup = () => { clearInterval(refresh); unsubscribe(); };
    // A client that navigates away or closes its tab never calls the
    // unsubscribe function above on its own - without this, the listener
    // stays registered on JobEvents forever, one per abandoned connection.
    req.on("close", cleanup);
    // A response can also die via an 'error' event (e.g. a reset connection)
    // without ever firing 'close' in time to beat the next publish() - clean
    // up here too so a broken SSE socket can never reach res.write().
    res.on("error", (err) => {
      log.error("SSE response errored", { jobId: req.params.id, err: String(err) });
      cleanup();
    });
    send();
  });

  return router;
}
