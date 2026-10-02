import { Router } from "express";
import { SESSION_COOKIE, SESSION_TTL_MS, signSession } from "../session";
import { MIN_PASSWORD_LENGTH } from "../passwords";
import type { UserRepository } from "../store/userRepository";
import type { OrgRepository } from "../store/orgRepository";
import type { UserRow } from "../store/rows";

function publicUser(user: UserRow) {
  return { id: user.id, username: user.username, email: user.email, isAdmin: user.isAdmin };
}

export function sessionRoutes(deps: {
  userRepo: UserRepository;
  orgRepo: OrgRepository;
  sessionSecret: string;
}): Router {
  const router = Router();

  router.post("/api/session", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Vary", "Cookie");
    const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
    if (typeof username !== "string" || typeof password !== "string") {
      res.status(400).json({ error: "username and password are required" });
      return;
    }

    // verifyCredentials folds "unknown username", "wrong password", and
    // "deactivated account" into the same undefined result - this endpoint
    // must not let a caller distinguish any of those three by response
    // shape (no username enumeration, no "this account is disabled" leak).
    const user = deps.userRepo.verifyCredentials(username, password);
    if (!user) {
      res.status(403).json({ error: "invalid username or password" });
      return;
    }

    const value = signSession(user.id, Date.now() + SESSION_TTL_MS, deps.sessionSecret, deps.userRepo.sessionVersion(user.id));
    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
    );
    res.status(200).json({ user: publicUser(user), orgs: deps.orgRepo.listForUser(user.id) });
  });

  router.get("/api/session", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Vary", "Cookie");
    if (!req.userId) {
      res.status(401).json({ error: "not logged in" });
      return;
    }
    const user = deps.userRepo.getById(req.userId);
    if (!user) {
      res.status(401).json({ error: "not logged in" });
      return;
    }
    res.status(200).json({ user: publicUser(user), orgs: deps.orgRepo.listForUser(user.id) });
  });

  // Self-service, not the admin-driven PATCH /api/admin/users/:id reset:
  // that route trusts admin authority in place of proving the current
  // password; this one requires the caller to prove they still are who the
  // session says they are, so a briefly-unattended logged-in session can't
  // be used to silently lock the real owner out. Mounted here (not behind
  // requireAuth, same as GET/DELETE above) because sessionRoutes is mounted
  // before the auth-guarded routers - req.userId comes from
  // attachUserFromCookie alone, checked manually like GET does.
  router.patch("/api/session/password", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Vary", "Cookie");
    if (!req.userId) {
      res.status(401).json({ error: "not logged in" });
      return;
    }
    const user = deps.userRepo.getById(req.userId);
    if (!user) {
      res.status(401).json({ error: "not logged in" });
      return;
    }

    const { currentPassword, newPassword } = (req.body ?? {}) as {
      currentPassword?: unknown;
      newPassword?: unknown;
    };
    if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
      res.status(400).json({ error: "currentPassword and newPassword are required" });
      return;
    }
    // Reject before verifying currentPassword: a too-short newPassword is a
    // client-side mistake, not something worth spending a password-hash
    // comparison to reject.
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      return;
    }
    // verifyCredentials, not a lower-level compare - reuses the exact same
    // deactivated-account/hash-mismatch handling POST /api/session already
    // relies on, so a deactivated account can't change its own password
    // even mid-session.
    if (!deps.userRepo.verifyCredentials(user.username, currentPassword)) {
      res.status(403).json({ error: "current password is incorrect" });
      return;
    }

    deps.userRepo.setPassword(user.id, newPassword);
    res.status(200).json({ ok: true });
  });

  router.delete("/api/session", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Vary", "Cookie");
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
    res.status(204).end();
  });

  return router;
}
