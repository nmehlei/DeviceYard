import { Router, type Request, type Response } from "express";
import type { OrgRepository } from "../store/orgRepository";
import type { UserTokenRepository } from "../store/userTokenRepository";

export function meRoutes(deps: {
  orgRepo: OrgRepository;
  userTokenRepo: UserTokenRepository;
}): Router {
  const router = Router();

  /** Identity for discovery: a PAT counts here, because GET /api/me/orgs is
   * the call a client makes to find out which org to ask for. */
  function anyIdentity(req: Request, res: Response): number | undefined {
    const userId = req.userId ?? req.patUserId;
    if (userId === undefined) {
      res.status(401).json({ error: "login required" });
      return undefined;
    }
    return userId;
  }

  /** Identity for token management: a session ONLY. A PAT that could create
   * tokens would mint its own successor and outlive its revocation, which
   * would quietly defeat the reason personal tokens are individually
   * revocable at all. */
  function sessionOnly(req: Request, res: Response): number | undefined {
    if (req.userId === undefined) {
      res.status(401).json({ error: "this needs a logged-in session, not a token" });
      return undefined;
    }
    return req.userId;
  }

  router.get("/api/me/orgs", (req, res) => {
    const userId = anyIdentity(req, res);
    if (userId === undefined) return;
    const orgs = deps.orgRepo.listForUser(userId).map((o) => ({ id: o.id, name: o.name }));
    res.status(200).json({ orgs });
  });

  router.get("/api/me/tokens", (req, res) => {
    const userId = sessionOnly(req, res);
    if (userId === undefined) return;
    // Every token here is decrypted plaintext (I5) - never let a shared or
    // browser cache hold onto this response. Same idiom as src/server.ts's
    // /status route.
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ tokens: deps.userTokenRepo.list(userId) });
  });

  router.post("/api/me/tokens", (req, res) => {
    const userId = sessionOnly(req, res);
    if (userId === undefined) return;
    const { label } = (req.body ?? {}) as { label?: unknown };
    if (typeof label !== "string" || !label.trim()) {
      res.status(400).json({ error: "label is required" });
      return;
    }
    // The response body is the newly created token in plaintext.
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json({ token: deps.userTokenRepo.generateAndCreate(userId, label.trim()) });
  });

  router.delete("/api/me/tokens/:tokenId", (req, res) => {
    const userId = sessionOnly(req, res);
    if (userId === undefined) return;
    deps.userTokenRepo.revoke(Number(req.params.tokenId), userId);
    res.status(204).end();
  });

  return router;
}
