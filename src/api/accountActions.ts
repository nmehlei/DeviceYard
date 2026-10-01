import { Router, type Request, type Response } from "express";
import { AccountActions, AccountActionError, validEmail, type ActionKind } from "../notifications/accounts";
import type { NotificationDeps } from "./notifications";

export function accountActionRoutes({ store, config }: NotificationDeps): Router {
  const router = Router(); const actions = new AccountActions(store);
  router.use((_, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  const run = (res: Response, work: () => void) => {
    try { work(); } catch (error) {
      if (error instanceof AccountActionError) res.status(error.status).json({ error: error.message });
      else res.status(500).json({ error: "The account action could not be completed. Try again." });
    }
  };
  function ready(res: Response): boolean {
    if (config.enabled) return true;
    res.status(503).json({ error: "Email is not configured. Contact your administrator." }); return false;
  }
  function session(req: Request, res: Response): number | undefined {
    if (!req.userId || req.header("authorization") || req.query.token) { res.status(401).json({ error: "login required" }); return; }
    return req.userId;
  }
  function limited(req: Request, res: Response, purpose: string, limit = 10): boolean {
    if (store.allow(`${purpose}:${req.ip}`, limit, 15 * 60_000)) return false;
    res.status(429).json({ error: "Too many requests. Please try again later." }); return true;
  }
  router.post("/api/account/password-reset", (req, res) => run(res, () => {
    if (!ready(res) || limited(req, res, "reset")) return;
    const email = req.body?.email;
    if (validEmail(email) && store.allow(`reset-email:${email}`, 3, 15 * 60_000)) {
      const user = store.db.get<{ id: number }>("SELECT id FROM users WHERE email=? AND deactivated_at IS NULL", email);
      if (user) actions.issue("password-reset", email, user.id);
    }
    res.status(202).json({ message: "If an active account matches that email, a reset link will be sent." });
  }));
  router.post("/api/account/verify-email", (req, res) => run(res, () => {
    const userId = session(req, res); if (!userId || !ready(res)) return;
    if (!store.allow(`verify:${userId}`, 3, 15 * 60_000)) { res.status(429).json({ error: "Please wait before requesting another verification email." }); return; }
    const user = store.db.get<{ email: string; email_verified_at: number | null }>("SELECT email,email_verified_at FROM users WHERE id=?", userId)!;
    if (user.email_verified_at === null) actions.issue("email-verification", user.email, userId);
    res.status(202).json({ ok: true });
  }));
  router.post("/api/account/actions/inspect", (req, res) => run(res, () => {
    if (limited(req, res, "action-inspect", 30)) return;
    const action = actions.inspect(req.body?.token);
    const org = action.org_id ? store.db.get<{ name: string }>("SELECT name FROM orgs WHERE id=?", action.org_id) : undefined;
    const existing = !!store.db.get("SELECT 1 FROM users WHERE email=?", action.email);
    res.json({ kind: action.kind, expiresAt: action.expires_at, organisationName: org?.name, existingAccount: existing });
  }));
  router.post("/api/account/actions/redeem", (req, res) => run(res, () => {
    if (limited(req, res, "action-redeem", 20)) return;
    const kind = req.body?.kind as ActionKind;
    if (!["invitation", "password-reset", "email-verification"].includes(kind)) { res.status(400).json({ error: "Invalid action." }); return; }
    actions.redeem(req.body?.token, kind, { password: req.body?.password, username: req.body?.username,
      signedInUserId: req.header("authorization") ? undefined : req.userId });
    res.json({ ok: true });
  }));
  function orgAccess(req: Request, res: Response): number | undefined {
    const userId = session(req, res); if (!userId) return;
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || !store.db.get(`SELECT 1 FROM orgs o WHERE o.id=? AND o.archived_at IS NULL
      AND (?=1 OR EXISTS(SELECT 1 FROM org_members WHERE org_id=o.id AND user_id=?))`, id, req.isAdmin ? 1 : 0, userId)) {
      res.status(404).json({ error: "organisation not found" }); return;
    }
    return id;
  }
  router.get("/api/orgs/:id/invitations", (req, res) => run(res, () => {
    const orgId = orgAccess(req, res); if (!orgId) return;
    res.json({ invitations: store.db.all(`SELECT id,email,expires_at AS expiresAt,created_at AS createdAt,
      CASE WHEN consumed_at IS NOT NULL THEN COALESCE(closed_reason,'closed') WHEN expires_at<=? THEN 'expired' ELSE 'pending' END AS status
      FROM notification_actions WHERE kind='invitation' AND org_id=? ORDER BY created_at DESC LIMIT 100`, store.now(), orgId) });
  }));
  router.post("/api/orgs/:id/invitations", (req, res) => run(res, () => {
    const orgId = orgAccess(req, res); if (!orgId || !ready(res)) return;
    if (!validEmail(req.body?.email)) { res.status(400).json({ error: "Enter a valid email address." }); return; }
    if (!store.allow(`invite:${req.userId}`, 20, 60 * 60_000)) { res.status(429).json({ error: "Invitation limit reached. Try again later." }); return; }
    const id = actions.issue("invitation", req.body.email, undefined, orgId, req.userId);
    res.status(202).json({ id });
  }));
  router.post("/api/orgs/:id/invitations/:actionId/resend", (req, res) => run(res, () => {
    const orgId = orgAccess(req, res); if (!orgId || !ready(res)) return;
    const invitation = store.db.get<{ email: string }>("SELECT email FROM notification_actions WHERE id=? AND org_id=? AND kind='invitation'", req.params.actionId, orgId);
    if (!invitation) { res.status(404).json({ error: "invitation not found" }); return; }
    if (!store.allow(`invite:${req.userId}`, 20, 60 * 60_000)) { res.status(429).json({ error: "Invitation limit reached. Try again later." }); return; }
    res.status(202).json({ id: actions.issue("invitation", invitation.email, undefined, orgId, req.userId) });
  }));
  router.delete("/api/orgs/:id/invitations/:actionId", (req, res) => run(res, () => {
    const orgId = orgAccess(req, res); if (!orgId) return;
    if (!store.db.get("SELECT 1 FROM notification_actions WHERE id=? AND org_id=? AND kind='invitation'", req.params.actionId, orgId)) { res.status(404).json({ error: "invitation not found" }); return; }
    store.cancelAction(req.params.actionId); res.status(204).end();
  }));
  return router;
}
