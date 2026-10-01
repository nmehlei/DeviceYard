import "express";

declare module "express-serve-static-core" {
  interface Request {
    org?: string;
    /** Set only for a cookie-authenticated request whose session cookie
     * named a still-active user - never set for a bearer-token (CI)
     * request, which has no user attached at all. */
    userId?: number;
    /** Mirrors the user's is_admin flag, set alongside userId. Always
     * false/undefined for a bearer-token request. */
    isAdmin?: boolean;
    /** Set only for a request authenticated by a personal access token.
     * Deliberately NOT userId: that field gates /api/orgs/* and /api/admin/*,
     * and a PAT must not reach them (spec D-2). Any route that wants a
     * person's full powers checks userId and will correctly reject a PAT. */
    patUserId?: number;
  }
}
