import type { RequestHandler } from "express";
import { SESSION_COOKIE, verifySession } from "./session";
import type { UserRepository } from "./store/userRepository";
import type { OrgRepository } from "./store/orgRepository";
import type { OrgTokenRepository } from "./store/orgTokenRepository";
import type { UserTokenRepository } from "./store/userTokenRepository";

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

/**
 * Always runs, never blocks: best-effort identifies a person from the
 * session cookie and attaches req.userId/req.isAdmin if it's valid and the
 * account is still active. Mounted early (before sessionRoutes), so
 * GET /api/session can see who's asking without itself sitting behind the
 * `requireAuth` gate - login/logout must stay reachable by a caller who
 * isn't authenticated yet.
 */
export function attachUserFromCookie(userRepo: UserRepository, sessionSecret: string): RequestHandler {
  return (req, _res, next) => {
    const userId = verifySession(readCookie(req.header("cookie"), SESSION_COOKIE), sessionSecret, Date.now(),
      (id) => userRepo.sessionVersion(id));
    if (userId !== undefined) {
      const user = userRepo.getById(userId);
      if (user && user.deactivatedAt === null) {
        req.userId = user.id;
        req.isAdmin = user.isAdmin;
      }
    }
    next();
  };
}

/**
 * Always runs, never blocks: best-effort identifies a person from a personal
 * access token in the Authorization header. Mounted early, beside
 * attachUserFromCookie, so routes that only need an identity (GET
 * /api/me/orgs) can see it without going through requireAuth's org
 * resolution - that call is how a client discovers which org to ask for.
 */
export function attachPatUser(userTokenRepo: UserTokenRepository): RequestHandler {
  return (req, _res, next) => {
    const [scheme, headerToken] = (req.header("authorization") ?? "").split(" ");
    const token = scheme === "Bearer" ? headerToken : undefined;
    if (!token) {
      next();
      return;
    }
    const found = userTokenRepo.findActiveByRawToken(token);
    if (found) {
      req.patUserId = found.userId;
      userTokenRepo.touchLastUsed(found.id);
    }
    next();
  };
}

/**
 * The actual gate in front of protected routers (mounted the same way
 * verifyBearerToken used to be). Two independent paths:
 *
 * - An explicit credential (Authorization header or ?token=) is checked
 *   first and wins if present, exactly as before - looked up against
 *   org_tokens now instead of TOKENS_JSON, but the same "explicit always
 *   wins over ambient" precedence.
 * - Otherwise, falls back to whatever attachUserFromCookie already
 *   populated. No cookie parsing happens here - if req.userId isn't set by
 *   this point, there is no valid session, full stop.
 *
 * req.org is resolved two different ways depending on which path
 * authenticated the request: from the token itself (bearer), or from an
 * X-Org-Id header (falling back to a ?orgId= query param when the header
 * isn't present, for the same reason the bearer-token check falls back from
 * its header to ?token= - some request types, like EventSource and <img>/<a>
 * URLs, can't set custom headers at all) validated against org_members
 * (cookie) - see the spec's addendum, "existing job/artifact routes", for
 * why this header exists instead of restructuring every job/artifact
 * route's URL.
 */
export function requireAuth(orgTokenRepo: OrgTokenRepository, orgRepo: OrgRepository): RequestHandler {
  return (req, res, next) => {
    const header = req.header("authorization") ?? "";
    const [scheme, headerToken] = header.split(" ");

    let token = scheme === "Bearer" ? headerToken : undefined;
    if (!token) {
      const queryToken = req.query.token;
      token = typeof queryToken === "string" ? queryToken : undefined;
    }

    if (token) {
      const orgName = orgTokenRepo.findActiveOrgNameByRawToken(token);
      if (!orgName) {
        // Not an org token. It may still be a personal access token, which
        // attachPatUser has already validated. A PAT is not scoped to one org,
        // so the caller must name which of their orgs this request is for.
        if (req.patUserId !== undefined) {
          // A PAT is a credential, not a session: strip any ambient cookie
          // identity for the same reason the org-token path does.
          delete req.userId;
          delete req.isAdmin;

          let selector = req.header("x-org-id");
          if (!selector) {
            const queryOrgId = req.query.orgId;
            selector = typeof queryOrgId === "string" ? queryOrgId : undefined;
          }
          const orgId = Number(selector);
          if (!selector || !Number.isInteger(orgId)) {
            res.status(403).json({
              error: "this token belongs to a person, not an org - name the org with the X-Org-Id header",
            });
            return;
          }
          if (!orgRepo.isMember(req.patUserId, orgId)) {
            res.status(403).json({ error: "not a member of that org" });
            return;
          }
          const org = orgRepo.getById(orgId);
          if (!org || org.archivedAt !== null) {
            res.status(403).json({ error: "not a member of that org" });
            return;
          }
          req.org = org.name;
          next();
          return;
        }
        res.status(403).json({ error: "invalid token" });
        return;
      }
      // A bearer token always represents a bare CI credential, never a
      // person - even if attachUserFromCookie already populated
      // req.userId/isAdmin from an ambient cookie sitting alongside this
      // explicit token, that identity must not leak onto a bearer-
      // authenticated request. Otherwise a CI token presented alongside a
      // stale admin cookie would look like an admin-authenticated request.
      delete req.userId;
      delete req.isAdmin;
      req.org = orgName;
      next();
      return;
    }

    if (!req.userId) {
      res.status(401).json({ error: "missing bearer token" });
      return;
    }

    const orgIdHeader = req.header("x-org-id");
    let orgIdValue = orgIdHeader;
    if (!orgIdValue) {
      const orgIdQuery = req.query.orgId;
      orgIdValue = typeof orgIdQuery === "string" ? orgIdQuery : undefined;
    }
    if (orgIdValue) {
      const orgId = Number(orgIdValue);
      if (Number.isInteger(orgId) && orgRepo.isMember(req.userId, orgId)) {
        const org = orgRepo.getById(orgId);
        if (org && org.archivedAt === null) req.org = org.name;
      }
    }
    next();
  };
}
