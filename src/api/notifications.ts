import { Router, type Request, type Response } from "express";
import { NotificationStore, type RunMode } from "../notifications/store";
import type { NotificationConfig } from "../notifications/config";
import { renderEmail, sampleEmail, type TemplateKind } from "../notifications/templates";

const KINDS: TemplateKind[] = ["run-result", "invitation", "password-reset", "email-verification", "device-offline", "device-recovered", "test"];
export interface NotificationDeps { store: NotificationStore; config: NotificationConfig }

export function notificationRoutes({ store, config }: NotificationDeps): Router {
  const router = Router();
  function session(req: Request, res: Response, admin = false): number | undefined {
    res.setHeader("Cache-Control", "no-store");
    if (!req.userId || req.header("authorization") || req.query.token) { res.status(401).json({ error: "login required" }); return; }
    if (admin && !req.isAdmin) { res.status(403).json({ error: "admin required" }); return; }
    return req.userId;
  }
  function preferences(userId: number) {
    const user = store.db.get<{ email: string; email_verified_at: number | null; is_admin: number }>("SELECT email,email_verified_at,is_admin FROM users WHERE id=?", userId)!;
    return { email: user.email, verified: user.email_verified_at !== null, isAdmin: !!user.is_admin,
      available: config.enabled,
      orgs: store.db.all(`SELECT o.id AS orgId,o.name AS orgName,COALESCE(p.mode,'off') AS run
        FROM orgs o JOIN org_members m ON m.org_id=o.id AND m.user_id=?
        LEFT JOIN notification_preferences p ON p.org_id=o.id AND p.user_id=m.user_id
        WHERE o.archived_at IS NULL ORDER BY o.name`, userId),
      deviceHealth: !!store.db.get("SELECT 1 FROM notification_health_preferences WHERE user_id=? AND enabled=1", userId) };
  }
  router.get("/api/me/notifications", (req, res) => {
    const id = session(req, res); if (!id) return; res.json(preferences(id));
  });
  router.put("/api/me/notifications", (req, res) => {
    const id = session(req, res); if (!id) return;
    const body = req.body as { orgs?: { orgId: number; run: RunMode }[]; deviceHealth?: boolean };
    if (!body || !Array.isArray(body.orgs) || body.orgs.length > 1000 || typeof body.deviceHealth !== "boolean" ||
      body.orgs.some((o) => !o || !Number.isSafeInteger(o.orgId) || !["off", "failures", "all"].includes(o.run)) ||
      new Set(body.orgs.map((o) => o.orgId)).size !== body.orgs.length) {
      res.status(400).json({ error: "valid organisation preferences and deviceHealth are required" }); return;
    }
    if (body.deviceHealth && !req.isAdmin) { res.status(403).json({ error: "device alerts require an administrator" }); return; }
    const current = preferences(id);
    const currentOrgs = current.orgs as { orgId: number; run: RunMode }[];
    const rank = { off: 0, failures: 1, all: 2 };
    const enabling = (body.deviceHealth && !current.deviceHealth) || body.orgs.some((o) =>
      rank[o.run] > rank[currentOrgs.find((old) => old.orgId === o.orgId)?.run ?? "off"]);
    if (enabling && (!config.enabled || !preferences(id).verified)) {
      res.status(409).json({ error: config.enabled ? "verify your email before enabling notifications" : "email is not configured" }); return;
    }
    for (const org of body.orgs) if (!store.db.get(`SELECT 1 FROM org_members m JOIN orgs o ON o.id=m.org_id
      WHERE m.user_id=? AND m.org_id=? AND o.archived_at IS NULL`, id, org.orgId)) {
      res.status(403).json({ error: "organisation membership required" }); return;
    }
    store.transaction(() => {
      store.db.run("DELETE FROM notification_preferences WHERE user_id=?", id);
      for (const org of body.orgs!) store.db.run("INSERT INTO notification_preferences(user_id,org_id,mode) VALUES (?,?,?)", id, org.orgId, org.run);
      store.db.run(`INSERT INTO notification_health_preferences VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled`, id, body.deviceHealth ? 1 : 0);
    });
    res.json(preferences(id));
  });
  router.get("/api/notifications/templates/:kind", (req, res) => {
    if (!session(req, res)) return;
    const kind = req.params.kind as TemplateKind;
    if (!KINDS.includes(kind)) { res.status(404).json({ error: "unknown template" }); return; }
    const preview = renderEmail(sampleEmail(kind), "https://example.invalid", { preview: true });
    res.json(preview);
  });
  router.get("/api/admin/notifications", (req, res) => {
    if (!session(req, res, true)) return;
    res.json({ status: config.status, ...(config.status === "invalid" ? { error: config.error } : {}),
      ...(config.enabled ? { sender: config.config.from, senderName: config.config.fromName } : {}),
      metrics: store.metrics() });
  });
  router.get("/api/admin/notifications/history", (req, res) => {
    if (!session(req, res, true)) return;
    const offset = Number(req.query.offset ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) { res.status(400).json({ error: "invalid offset" }); return; }
    res.json({ items: store.history(offset), offset });
  });
  router.post("/api/admin/notifications/test", (req, res) => {
    const id = session(req, res, true); if (!id) return;
    if (!config.enabled) { res.status(503).json({ error: "email is not configured" }); return; }
    const user = store.db.get<{ email: string; username: string; email_verified_at: number | null }>("SELECT email,username,email_verified_at FROM users WHERE id=?", id)!;
    if (user.email_verified_at === null) { res.status(409).json({ error: "verify your email first" }); return; }
    if (!store.allow(`test:${id}`, 1, 60_000)) { res.status(429).json({ error: "wait one minute before sending another test" }); return; }
    store.enqueue({ eventKey: `test:${id}:${store.now()}`, kind: "test", userId: id,
      payload: { to: user.email, data: { kind: "test", recipientName: user.username, actionUrl: "/notifications" } } });
    res.status(202).json({ ok: true });
  });
  return router;
}
