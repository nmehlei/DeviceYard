import express from "express";
import request from "supertest";
import { attachUserFromCookie, requireAuth } from "../src/auth";
import { SESSION_COOKIE, SESSION_TTL_MS, signSession } from "../src/session";
import type { UserRepository } from "../src/store/userRepository";
import type { OrgRepository } from "../src/store/orgRepository";
import type { OrgTokenRepository } from "../src/store/orgTokenRepository";
import type { UserRow } from "../src/store/rows";

const SECRET = "test-session-secret";

const ACTIVE_USER: UserRow = {
  id: 1,
  username: "nicolas",
  email: "n@example.com",
  isAdmin: false,
  deactivatedAt: null,
  createdAt: 0,
};

const ADMIN_USER: UserRow = { ...ACTIVE_USER, id: 2, username: "admin", isAdmin: true };
const DEACTIVATED_USER: UserRow = { ...ACTIVE_USER, id: 3, username: "gone", deactivatedAt: 123 };

function fakeUserRepo(users: UserRow[]): UserRepository {
  return {
    getById: (id: number) => users.find((u) => u.id === id),
    sessionVersion: (id: number) => users.some((u) => u.id === id) ? 0 : undefined,
  } as unknown as UserRepository;
}

function fakeOrgTokenRepo(tokensByOrg: Record<string, string>): OrgTokenRepository {
  return {
    findActiveOrgNameByRawToken: (token: string) =>
      Object.keys(tokensByOrg).find((org) => tokensByOrg[org] === token),
  } as unknown as OrgTokenRepository;
}

function fakeOrgRepo(
  memberships: Record<number, number[]>,
  orgNames: Record<number, string>,
  archivedOrgIds: number[] = []
): OrgRepository {
  return {
    isMember: (userId: number, orgId: number) => (memberships[orgId] ?? []).includes(userId),
    getById: (orgId: number) =>
      orgNames[orgId]
        ? {
            id: orgId,
            name: orgNames[orgId],
            archivedAt: archivedOrgIds.includes(orgId) ? 123 : null,
            createdAt: 0,
          }
        : undefined,
  } as unknown as OrgRepository;
}

function buildApp(opts: {
  users?: UserRow[];
  tokensByOrg?: Record<string, string>;
  memberships?: Record<number, number[]>;
  orgNames?: Record<number, string>;
  archivedOrgIds?: number[];
  secret?: string;
}) {
  const app = express();
  const userRepo = fakeUserRepo(opts.users ?? [ACTIVE_USER, ADMIN_USER, DEACTIVATED_USER]);
  const orgTokenRepo = fakeOrgTokenRepo(opts.tokensByOrg ?? { donable: "donable-token-123" });
  const orgRepo = fakeOrgRepo(
    opts.memberships ?? { 10: [ACTIVE_USER.id] },
    opts.orgNames ?? { 10: "donable" },
    opts.archivedOrgIds ?? []
  );

  app.use(attachUserFromCookie(userRepo, opts.secret ?? SECRET));
  app.get("/protected", requireAuth(orgTokenRepo, orgRepo), (req, res) => {
    res.status(200).json({ org: req.org, userId: req.userId, isAdmin: req.isAdmin });
  });
  return app;
}

function cookieFor(userId: number, secret: string = SECRET, expiresAt: number = Date.now() + SESSION_TTL_MS): string {
  return `${SESSION_COOKIE}=${signSession(userId, expiresAt, secret)}`;
}

describe("bearer token path", () => {
  test("401 when neither a bearer token nor a session cookie is present", async () => {
    const res = await request(buildApp({})).get("/protected");
    expect(res.status).toBe(401);
  });

  test("403 when the token does not match any org", async () => {
    const res = await request(buildApp({})).get("/protected").set("Authorization", "Bearer wrong-token");
    expect(res.status).toBe(403);
  });

  test("200 and sets req.org, with no userId/isAdmin, when the token matches", async () => {
    const res = await request(buildApp({})).get("/protected").set("Authorization", "Bearer donable-token-123");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ org: "donable" });
  });

  test("a ?token= query param works the same as the header", async () => {
    const res = await request(buildApp({})).get("/protected?token=donable-token-123");
    expect(res.status).toBe(200);
    expect(res.body.org).toBe("donable");
  });

  test("a bearer token wins over a cookie for a different identity", async () => {
    const res = await request(buildApp({}))
      .get("/protected")
      .set("Authorization", "Bearer donable-token-123")
      .set("Cookie", cookieFor(ADMIN_USER.id));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ org: "donable" });
  });
});

describe("cookie path", () => {
  test("a valid cookie with no X-Org-Id header authenticates but leaves req.org unset", async () => {
    const res = await request(buildApp({}))
      .get("/protected")
      .set("Cookie", cookieFor(ACTIVE_USER.id));
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(ACTIVE_USER.id);
    expect(res.body.org).toBeUndefined();
  });

  test("X-Org-Id resolves req.org when the user is a member of that org", async () => {
    const res = await request(buildApp({}))
      .get("/protected")
      .set("Cookie", cookieFor(ACTIVE_USER.id))
      .set("X-Org-Id", "10");
    expect(res.status).toBe(200);
    expect(res.body.org).toBe("donable");
  });

  test("X-Org-Id for an org the user is NOT a member of is ignored - req.org stays unset, not 403", async () => {
    const res = await request(buildApp({}))
      .get("/protected")
      .set("Cookie", cookieFor(ACTIVE_USER.id))
      .set("X-Org-Id", "999");
    expect(res.status).toBe(200);
    expect(res.body.org).toBeUndefined();
  });

  test("X-Org-Id naming an archived org is ignored - req.org stays unset, not an error", async () => {
    const res = await request(buildApp({ archivedOrgIds: [10] }))
      .get("/protected")
      .set("Cookie", cookieFor(ACTIVE_USER.id))
      .set("X-Org-Id", "10");
    expect(res.status).toBe(200);
    expect(res.body.org).toBeUndefined();
  });

  test("a ?orgId= query param resolves req.org the same as the X-Org-Id header, when the user is a member", async () => {
    const res = await request(buildApp({}))
      .get("/protected?orgId=10")
      .set("Cookie", cookieFor(ACTIVE_USER.id));
    expect(res.status).toBe(200);
    expect(res.body.org).toBe("donable");
  });

  test("absent header AND absent ?orgId= query param leaves req.org unset, unchanged from today", async () => {
    const res = await request(buildApp({}))
      .get("/protected")
      .set("Cookie", cookieFor(ACTIVE_USER.id));
    expect(res.status).toBe(200);
    expect(res.body.org).toBeUndefined();
  });

  test("req.isAdmin is set for an admin user", async () => {
    const res = await request(buildApp({}))
      .get("/protected")
      .set("Cookie", cookieFor(ADMIN_USER.id));
    expect(res.status).toBe(200);
    expect(res.body.isAdmin).toBe(true);
  });

  test("a deactivated user's cookie is treated as unauthenticated", async () => {
    const res = await request(buildApp({}))
      .get("/protected")
      .set("Cookie", cookieFor(DEACTIVATED_USER.id));
    expect(res.status).toBe(401);
  });

  test("an expired cookie is rejected", async () => {
    const res = await request(buildApp({}))
      .get("/protected")
      .set("Cookie", cookieFor(ACTIVE_USER.id, SECRET, Date.now() - 1000));
    expect(res.status).toBe(401);
  });

  test("a cookie signed with a different secret is rejected", async () => {
    const res = await request(buildApp({}))
      .get("/protected")
      .set("Cookie", cookieFor(ACTIVE_USER.id, "a-different-secret"));
    expect(res.status).toBe(401);
  });

  test("a malformed cookie returns a normal 401, not a 500", async () => {
    const res = await request(buildApp({})).get("/protected").set("Cookie", `${SESSION_COOKIE}=%`);
    expect(res.status).toBe(401);
  });
});
