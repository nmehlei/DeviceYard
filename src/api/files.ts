import fs from "fs";
import path from "path";
import { Router } from "express";
import { log } from "../telemetry/log";
import type { Request, Response } from "express";
import type { JobRepository } from "../store/jobRepository";

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".json": "application/json",
  ".xml": "application/xml",
  ".log": "text/plain; charset=utf-8",
};

export function fileRoutes(deps: { repo: JobRepository; dataDir: string }): Router {
  const router = Router();
  const artifactRoot = path.resolve(deps.dataDir, "artifacts");

  /** Never trust a stored path to stay inside the artifact root. Rows are
   * written by this service, but a resolve-and-check is one line and removes
   * the class of bug entirely. */
  const resolveInside = (relPath: string): string | undefined => {
    const resolved = path.resolve(artifactRoot, relPath);
    return resolved.startsWith(artifactRoot + path.sep) ? resolved : undefined;
  };

  // Ownership is derived from the foreign key chain (flow_runs.job_id ->
  // jobs.org), never from parsing the stored relPath. The relPath happens to
  // start with the job id today only because jobRunner builds it that way -
  // a future change to the artifact directory layout would silently
  // mis-attribute ownership of what are, for real jobs, screenshots of the
  // device owner's actual logged-in app sessions.
  const stepOrg = (stepId: number): string | undefined => {
    const step = deps.repo.getStep(stepId);
    if (!step) return undefined;
    return deps.repo.getJob(step.jobId)?.org;
  };

  const setPrivateHeaders = (res: Response): void => {
    // These responses can carry screenshots of a real, logged-in app
    // session - the same reasons GET /jobs is no-store/Vary: Cookie apply
    // here, plus nosniff since a browser must never guess its way around
    // the declared Content-Type for user-controlled bytes.
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Vary", "Cookie");
    res.setHeader("X-Content-Type-Options", "nosniff");
  };

  /** Pipe a file to the response, but never let a stream 'error' (e.g. the
   * file vanishing between existsSync and the read) become an uncaught
   * exception - this is a single-process, internet-facing service and an
   * uncaught exception takes the whole farm down, including CI. */
  const pipeFile = (resolved: string, res: Response, notFoundBody: object): void => {
    const stream = fs.createReadStream(resolved);
    stream.on("error", (err) => {
      log.error("failed to read artifact file", { path: resolved, err: String(err) });
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.status(404).json(notFoundBody);
    });
    stream.pipe(res);
  };

  /** Same "never let a stream error become an uncaught exception" rule as
   * pipeFile, plus HTTP Range support: Safari in particular refuses to play
   * <video> content at all unless a 206/Content-Range response is available,
   * and it probes with a `Range: bytes=0-1` request before it will start.
   * Applied to every artifact (screenshots, dumps, recordings alike) rather
   * than gated on content type - Range support is harmless and correct for
   * any file, and it's one code path instead of two. */
  const pipeFileWithRange = (resolved: string, req: Request, res: Response, notFoundBody: object): void => {
    let size: number;
    try {
      size = fs.statSync(resolved).size;
    } catch (err) {
      log.error("failed to stat artifact file", { path: resolved, err: String(err) });
      res.status(404).json(notFoundBody);
      return;
    }

    res.setHeader("Accept-Ranges", "bytes");

    const rangeHeader = req.headers.range;
    let start = 0;
    let end = size - 1;

    if (typeof rangeHeader === "string") {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      const startStr = match?.[1] ?? "";
      const endStr = match?.[2] ?? "";
      if (!match || (startStr === "" && endStr === "")) {
        // Malformed - fall back to a normal full-file 200 response rather
        // than erroring out.
      } else {
        start = startStr === "" ? size - Number(endStr) : Number(startStr);
        end = endStr === "" || startStr === "" ? size - 1 : Number(endStr);

        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start < 0 || end >= size) {
          res.status(416).setHeader("Content-Range", `bytes */${size}`);
          res.end();
          return;
        }

        res.status(206);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
      }
    }

    res.setHeader("Content-Length", String(Math.max(0, end - start + 1)));

    // A zero-byte artifact (an empty stderr.log is routine) has no byte to
    // read: `end` is -1 here, and fs.createReadStream({ end: -1 }) throws a
    // RangeError synchronously - past the stream's own "error" handler, so
    // it surfaced as a 500 with a stack trace rather than an empty 200.
    if (end < start) {
      res.end();
      return;
    }

    const stream = fs.createReadStream(resolved, { start, end });
    stream.on("error", (err) => {
      log.error("failed to read artifact file", { path: resolved, err: String(err) });
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.status(404).json(notFoundBody);
    });
    stream.pipe(res);
  };

  router.get("/api/flow-runs/:id/log", (req, res) => {
    const stepId = Number(req.params.id);
    const stream = req.query.stream === "stderr" ? "stderr" : "stdout";
    if (!Number.isInteger(stepId) || stepOrg(stepId) !== req.org) {
      res.status(404).json({ error: "log not found" });
      return;
    }

    const artifact = deps.repo.getArtifacts(stepId).find((a) => a.kind === stream);
    const resolved = artifact ? resolveInside(artifact.relPath) : undefined;
    if (!resolved || !fs.existsSync(resolved)) {
      res.status(404).json({ error: "log not found" });
      return;
    }

    setPrivateHeaders(res);
    res.status(200).type("text/plain; charset=utf-8");
    pipeFile(resolved, res, { error: "log not found" });
  });

  router.get("/api/artifacts/:id", (req, res) => {
    const id = Number(req.params.id);
    const artifact = Number.isInteger(id) ? deps.repo.getArtifact(id) : undefined;
    if (!artifact || stepOrg(artifact.flowRunId) !== req.org) {
      res.status(404).json({ error: "artifact not found" });
      return;
    }

    const resolved = resolveInside(artifact.relPath);
    if (!resolved || !fs.existsSync(resolved)) {
      res.status(404).json({ error: "artifact not found" });
      return;
    }

    setPrivateHeaders(res);
    res.type(CONTENT_TYPES[path.extname(resolved).toLowerCase()] ?? "application/octet-stream");
    pipeFileWithRange(resolved, req, res, { error: "artifact not found" });
  });

  return router;
}
