import fs from "fs";
import { Router } from "express";
import { log } from "../telemetry/log";

/** Serves the CLI install script.
 *
 * Deliberately UNAUTHENTICATED, and mounted ahead of the org gate: you install
 * the CLI before you have a credential, and a 401 on the install line would be
 * the first thing a new user hits. The script itself carries no secret - it
 * resolves public packages from registry.npmjs.org.
 *
 * Not an express.static mount, for the same reason as /api/mcp-client: this is
 * one known file, and a static root at dist/ would expose the whole compiled
 * service. */
export function cliRoutes(deps: { installScriptPath: string }): Router {
  const router = Router();

  router.get("/cli/install.sh", (_req, res) => {
    // A script can be absent on a from-source dev run that never packaged one.
    // That is an operational state, not a crash.
    if (!fs.existsSync(deps.installScriptPath)) {
      res.status(503).json({ error: "the CLI install script is not available in this build" });
      return;
    }

    res.setHeader("Content-Type", "text/x-shellscript; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");

    const stream = fs.createReadStream(deps.installScriptPath);
    // Never let a stream 'error' (e.g. the file vanishing between existsSync
    // and the read) become an uncaught exception - this is a single-process,
    // internet-facing service and the artifact routes already learned that
    // lesson the hard way.
    stream.on("error", (err) => {
      log.error("failed to read cli install script", {
        path: deps.installScriptPath,
        err: String(err),
      });
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.status(500).json({ error: "failed to read the CLI install script" });
    });
    stream.pipe(res);
  });

  return router;
}
