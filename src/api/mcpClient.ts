import fs from "fs";
import { Router } from "express";
import { log } from "../telemetry/log";

/** Serves the esbuild-produced MCP client bundle to any caller the existing
 * auth already accepted. Deliberately not a static mount: the bundle is one
 * known file, and an express.static rooted at dist/ would expose the whole
 * compiled service. */
export function mcpClientRoutes(deps: { bundlePath: string }): Router {
  const router = Router();

  router.get("/api/mcp-client", (_req, res) => {
    // A bundle can be absent on a from-source dev run that never ran
    // build:mcp. That is an operational state, not a crash.
    if (!fs.existsSync(deps.bundlePath)) {
      res.status(503).json({ error: "the MCP client bundle is not available in this build" });
      return;
    }
    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", 'attachment; filename="mcp.mjs"');

    const stream = fs.createReadStream(deps.bundlePath);
    // Never let a stream 'error' (e.g. the file vanishing between
    // existsSync and the read) become an uncaught exception - this is a
    // single-process, internet-facing service and the artifact routes
    // already learned that lesson the hard way.
    stream.on("error", (err) => {
      log.error("failed to read mcp client bundle", { path: deps.bundlePath, err: String(err) });
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.status(500).json({ error: "failed to read the MCP client bundle" });
    });
    stream.pipe(res);
  });

  return router;
}
