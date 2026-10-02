import { Router, type Request, type Response } from "express";
import type { OrgRepository } from "../store/orgRepository";
import type { UserRepository } from "../store/userRepository";
import { DEFAULT_MAX_UPLOAD_BYTES, type JobRepository } from "../store/jobRepository";
import { MIN_PASSWORD_LENGTH } from "../passwords";

export function adminRoutes(deps: { orgRepo: OrgRepository; userRepo: UserRepository; repo: JobRepository }): Router {
  const router = Router();

  /** Every route here is admin-only - centralised so a route can't
   * accidentally skip the check. A bearer-token/CI request never sets
   * req.isAdmin, so it falls through to false here and is rejected too. */
  function requireAdmin(req: Request, res: Response): boolean {
    if (!req.isAdmin) {
      res.status(403).json({ error: "admin access required" });
      return false;
    }
    return true;
  }

  router.get("/api/admin/orgs", (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.status(200).json({ orgs: deps.orgRepo.list() });
  });

  router.post("/api/admin/orgs", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { name, initialMemberUserIds } = (req.body ?? {}) as { name?: unknown; initialMemberUserIds?: unknown };
    if (typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (deps.orgRepo.getByName(name.trim())) {
      res.status(409).json({ error: `org ${name.trim()} already exists` });
      return;
    }
    // An explicit empty array must fall back to the creating admin too, not
    // just an absent/malformed field - otherwise POST with
    // initialMemberUserIds: [] creates an org with zero members that
    // nobody, including admins (requireMember has no bypass for a
    // *nonexistent* membership row), could ever reach again.
    const resolvedMembers =
      Array.isArray(initialMemberUserIds) && initialMemberUserIds.every((id) => typeof id === "number")
        ? (initialMemberUserIds as number[])
        : [];
    const members = resolvedMembers.length > 0 ? resolvedMembers : [req.userId as number];
    const org = deps.orgRepo.create(name.trim(), members);
    res.status(201).json({ org });
  });

  router.patch("/api/admin/orgs/:id", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { name } = (req.body ?? {}) as { name?: unknown };
    if (typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const org = deps.orgRepo.getById(Number(req.params.id));
    if (!org) {
      res.status(404).json({ error: "unknown org" });
      return;
    }
    deps.orgRepo.rename(org.id, name.trim());
    res.status(200).json({ org: deps.orgRepo.getById(org.id) });
  });

  router.delete("/api/admin/orgs/:id", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const org = deps.orgRepo.getById(Number(req.params.id));
    if (!org) {
      res.status(404).json({ error: "unknown org" });
      return;
    }
    deps.orgRepo.archive(org.id);
    res.status(204).end();
  });

  router.get("/api/admin/users", (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.status(200).json({ users: deps.userRepo.list() });
  });

  router.post("/api/admin/users", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { username, email, password, isAdmin } = (req.body ?? {}) as {
      username?: unknown;
      email?: unknown;
      password?: unknown;
      isAdmin?: unknown;
    };
    if (typeof username !== "string" || !username.trim()) {
      res.status(400).json({ error: "username is required" });
      return;
    }
    if (typeof email !== "string" || !email.trim()) {
      res.status(400).json({ error: "email is required" });
      return;
    }
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
      res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      return;
    }
    if (deps.userRepo.getByUsername(username.trim())) {
      res.status(409).json({ error: `username ${username.trim()} is already taken` });
      return;
    }
    const user = deps.userRepo.create({
      username: username.trim(),
      email: email.trim(),
      password,
      isAdmin: isAdmin === true,
    });
    res.status(201).json({ user });
  });

  router.patch("/api/admin/users/:id", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const user = deps.userRepo.getById(Number(req.params.id));
    if (!user) {
      res.status(404).json({ error: "unknown user" });
      return;
    }
    const { isAdmin, password } = (req.body ?? {}) as { isAdmin?: unknown; password?: unknown };
    // Symmetric with create-user: a too-short password must reject with a
    // 400 before any change is made, not silently drop the reset while
    // still returning 200 - a caller resetting a password must be able to
    // trust a 200 means the reset actually happened.
    if (typeof password === "string" && password.length < MIN_PASSWORD_LENGTH) {
      res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      return;
    }
    if (typeof isAdmin === "boolean") deps.userRepo.setAdmin(user.id, isAdmin);
    if (typeof password === "string") {
      deps.userRepo.setPassword(user.id, password);
    }
    res.status(200).json({ user: deps.userRepo.getById(user.id) });
  });

  router.delete("/api/admin/users/:id", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const user = deps.userRepo.getById(Number(req.params.id));
    if (!user) {
      res.status(404).json({ error: "unknown user" });
      return;
    }
    deps.userRepo.deactivate(user.id);
    res.status(204).end();
  });

  router.get("/api/admin/retention", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const settings = deps.repo.getRetentionSettings();
    res.status(200).json({
      maxAgeDays: settings?.maxAgeDays ?? null,
      maxTotalBytes: settings?.maxTotalBytes ?? null,
      maxJobs: settings?.maxJobs ?? null,
      totalArtifactBytes: deps.repo.totalArtifactBytes(),
    });
  });

  router.put("/api/admin/retention", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { maxAgeDays, maxTotalBytes, maxJobs } = (req.body ?? {}) as {
      maxAgeDays?: unknown;
      maxTotalBytes?: unknown;
      maxJobs?: unknown;
    };

    // Returns the parsed value, or `undefined` as a sentinel for "invalid" -
    // distinct from a parsed `null` (which means "disabled" and is valid).
    const parseThreshold = (value: unknown): number | null | undefined => {
      if (value === null || value === undefined) return null;
      if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
      return undefined;
    };

    const parsed = {
      maxAgeDays: parseThreshold(maxAgeDays),
      maxTotalBytes: parseThreshold(maxTotalBytes),
      maxJobs: parseThreshold(maxJobs),
    };

    if (Object.values(parsed).some((v) => v === undefined)) {
      res.status(400).json({
        error: "maxAgeDays, maxTotalBytes and maxJobs must each be a non-negative integer or null",
      });
      return;
    }

    const saved = deps.repo.setRetentionSettings({
      maxAgeDays: parsed.maxAgeDays as number | null,
      maxTotalBytes: parsed.maxTotalBytes as number | null,
      maxJobs: parsed.maxJobs as number | null,
    });
    res.status(200).json({
      maxAgeDays: saved.maxAgeDays,
      maxTotalBytes: saved.maxTotalBytes,
      maxJobs: saved.maxJobs,
      totalArtifactBytes: deps.repo.totalArtifactBytes(),
    });
  });

  /** The shape both upload routes return. `maxUploadBytes` is what is stored
   * (null = admin chose unlimited, absent row = never configured);
   * `effectiveMaxUploadBytes` is what POST /run enforces right now. Returning
   * both means the dashboard never has to reimplement the three-state rule. */
  const uploadPayload = () => ({
    maxUploadBytes: deps.repo.getUploadSettings()?.maxUploadBytes ?? null,
    effectiveMaxUploadBytes: deps.repo.effectiveUploadLimit(),
    defaultMaxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
  });

  router.get("/api/admin/upload", (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.status(200).json(uploadPayload());
  });

  router.put("/api/admin/upload", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { maxUploadBytes } = (req.body ?? {}) as { maxUploadBytes?: unknown };

    // null is a valid, meaningful value here ("no limit"), so it cannot be
    // folded in with the invalid cases - same three-way parse the retention
    // route uses, but with a stricter lower bound: 0 would mean "reject every
    // upload", which is a footgun rather than a setting an admin wants.
    // `undefined` is NOT folded in with `null` here. Only an explicit null
    // means "no limit"; a body that simply omits the key is malformed, and
    // treating it as null would let a typo disable the protection with a 200.
    let parsed: number | null;
    if (maxUploadBytes === null) {
      parsed = null;
    } else if (typeof maxUploadBytes === "number" && Number.isInteger(maxUploadBytes) && maxUploadBytes > 0) {
      parsed = maxUploadBytes;
    } else {
      res.status(400).json({
        error: "maxUploadBytes must be a positive integer number of bytes, or null for no limit",
      });
      return;
    }

    deps.repo.setUploadSettings({ maxUploadBytes: parsed });
    res.status(200).json(uploadPayload());
  });

  router.get("/api/admin/scheduler", (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.status(200).json({ maxConcurrentJobs: deps.repo.getSchedulerSettings()?.maxConcurrentJobs ?? null });
  });

  router.put("/api/admin/scheduler", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Explicit key check: PUT /api/admin/upload with {} once silently
    // disabled the upload cap because an absent key read as "no limit".
    // Absent means "you forgot to send it", null means "no cap".
    if (!("maxConcurrentJobs" in body)) {
      res.status(400).json({ error: "maxConcurrentJobs is required - send null for no cap" });
      return;
    }
    const value = body.maxConcurrentJobs;
    if (value !== null && (typeof value !== "number" || !Number.isInteger(value) || value < 1)) {
      res.status(400).json({ error: "maxConcurrentJobs must be a positive integer, or null for no cap" });
      return;
    }

    const saved = deps.repo.setSchedulerSettings({ maxConcurrentJobs: value as number | null });
    res.status(200).json({ maxConcurrentJobs: saved.maxConcurrentJobs });
  });

  return router;
}
