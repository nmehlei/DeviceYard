import { Router, type Request, type Response } from "express";
import type { OrgRepository } from "../store/orgRepository";
import type { OrgTokenRepository } from "../store/orgTokenRepository";
import type { UserRepository } from "../store/userRepository";

export function orgRoutes(deps: {
  orgRepo: OrgRepository;
  tokenRepo: OrgTokenRepository;
  userRepo: UserRepository;
}): Router {
  const router = Router();

  /** Every route here needs the same "is this a logged-in member of :id"
   * check - centralised so a route can't accidentally skip it. Returns the
   * parsed orgId on success, or undefined after already writing the error
   * response (callers must return immediately when this returns undefined).
   *
   * Two special cases:
   * - Admin bypass (spec: "admins can manage membership on any org
   *   regardless of their own membership") - an admin passes this check for
   *   any org id, still 404 for a genuinely nonexistent org.
   * - Archived orgs 404 for everyone, members included (spec addendum:
   *   "/api/orgs/:id/... routes 404 for everyone, members included"). Choice
   *   made here: the admin bypass above deliberately also bypasses this
   *   archived check, so an admin can still inspect/manage an archived
   *   org's membership for cleanup purposes - a non-admin member of an
   *   archived org gets the same 404 a non-member would. */
  function requireMember(req: Request, res: Response): number | undefined {
    if (!req.userId) {
      res.status(401).json({ error: "login required" });
      return undefined;
    }
    const orgId = Number(req.params.id);
    if (!Number.isInteger(orgId)) {
      res.status(404).json({ error: "org not found" });
      return undefined;
    }

    if (req.isAdmin) {
      if (!deps.orgRepo.getById(orgId)) {
        res.status(404).json({ error: "org not found" });
        return undefined;
      }
      return orgId;
    }

    if (!deps.orgRepo.isMember(req.userId, orgId)) {
      // 404, not 403: a non-member gets no confirmation the org even exists.
      res.status(404).json({ error: "org not found" });
      return undefined;
    }
    const org = deps.orgRepo.getById(orgId);
    if (!org || org.archivedAt !== null) {
      // Same 404 shape as "org not found" - don't reveal to a member of an
      // archived org that it still technically exists.
      res.status(404).json({ error: "org not found" });
      return undefined;
    }
    return orgId;
  }

  router.get("/api/orgs/:id/members", (req, res) => {
    const orgId = requireMember(req, res);
    if (orgId === undefined) return;
    res.status(200).json({ members: deps.orgRepo.listMembers(orgId) });
  });

  router.post("/api/orgs/:id/members", (req, res) => {
    const orgId = requireMember(req, res);
    if (orgId === undefined) return;
    const { userId } = (req.body ?? {}) as { userId?: unknown };
    if (typeof userId !== "number") {
      res.status(400).json({ error: "userId is required" });
      return;
    }
    if (!deps.userRepo.getById(userId)) {
      res.status(404).json({ error: "unknown user" });
      return;
    }
    deps.orgRepo.addMember(orgId, userId);
    res.status(201).json({ ok: true });
  });

  router.delete("/api/orgs/:id/members/:userId", (req, res) => {
    const orgId = requireMember(req, res);
    if (orgId === undefined) return;
    const targetUserId = Number(req.params.userId);
    // Removing an org's last member is a dead end - nobody, including an
    // admin without an existing membership row, could ever add the org's
    // second member back through the ordinary member routes. Block it here
    // rather than relying on the admin-create-org fix (Fix in admin.ts) to
    // prevent every path into a zero-member org.
    const members = deps.orgRepo.listMembers(orgId);
    if (members.length === 1 && members[0].id === targetUserId) {
      res.status(409).json({ error: "cannot remove the last member of an org" });
      return;
    }
    deps.orgRepo.removeMember(orgId, targetUserId);
    res.status(204).end();
  });

  router.get("/api/orgs/:id/tokens", (req, res) => {
    const orgId = requireMember(req, res);
    if (orgId === undefined) return;
    // Every token here is decrypted plaintext - never let a shared or
    // browser cache hold onto this response. Same idiom as src/server.ts's
    // /status route and the personal-token equivalent in src/api/me.ts.
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ tokens: deps.tokenRepo.list(orgId) });
  });

  router.post("/api/orgs/:id/tokens", (req, res) => {
    const orgId = requireMember(req, res);
    if (orgId === undefined) return;
    const { label } = (req.body ?? {}) as { label?: unknown };
    if (typeof label !== "string" || !label.trim()) {
      res.status(400).json({ error: "label is required" });
      return;
    }
    // The response body is the newly created token in plaintext.
    res.setHeader("Cache-Control", "no-store");
    const token = deps.tokenRepo.generateAndCreate(orgId, label.trim(), req.userId ?? null);
    res.status(201).json({ token });
  });

  router.delete("/api/orgs/:id/tokens/:tokenId", (req, res) => {
    const orgId = requireMember(req, res);
    if (orgId === undefined) return;
    deps.tokenRepo.revoke(Number(req.params.tokenId), orgId);
    res.status(204).end();
  });

  return router;
}
