import { randomUUID } from "node:crypto";
import { generateToken, hashToken } from "../tokenCrypto";
import { hashPassword, MIN_PASSWORD_LENGTH } from "../passwords";
import { NotificationStore, DAY_MS } from "./store";
import type { EmailData } from "./templates";

export type ActionKind = "invitation" | "password-reset" | "email-verification";
export interface AccountAction {
  id: string; kind: ActionKind; email: string; user_id: number | null;
  org_id: number | null; created_by: number | null; expires_at: number;
}
export class AccountActionError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export function validEmail(email: unknown): email is string {
  return typeof email === "string" && email.length <= 254 && /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(email);
}

export class AccountActions {
  constructor(private readonly store: NotificationStore) {}

  issue(kind: ActionKind, email: string, userId?: number, orgId?: number, createdBy?: number): string {
    return this.store.transaction(() => {
      const now = this.store.now(); const id = randomUUID(); const token = generateToken();
      const expiresAt = now + (kind === "invitation" ? 7 * DAY_MS : kind === "password-reset" ? 30 * 60_000 : DAY_MS);
      const previous = this.store.db.all<{ id: string }>(`SELECT id FROM notification_actions
        WHERE kind=? AND email=? AND org_id IS ? AND consumed_at IS NULL`, kind, email, orgId ?? null);
      for (const action of previous) this.store.cancelAction(action.id, "superseded");
      this.store.db.run(`INSERT INTO notification_actions(id,kind,token_hash,email,user_id,org_id,created_by,expires_at,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`, id, kind, hashToken(token), email, userId, orgId, createdBy, expiresAt, now);
      const recipient = userId ? this.store.db.get<{ username: string }>("SELECT username FROM users WHERE id=?", userId)?.username ?? "there" : "there";
      const page = kind === "invitation" ? "accept-invitation" : kind === "password-reset" ? "reset-password" : "verify-email";
      // Fragment stays out of HTTP access logs and referrer headers.
      const actionUrl = `/${page}#token=${encodeURIComponent(token)}`;
      let data: EmailData;
      if (kind === "invitation") {
        const org = this.store.db.get<{ name: string }>("SELECT name FROM orgs WHERE id=?", orgId);
        const inviter = this.store.db.get<{ username: string }>("SELECT username FROM users WHERE id=?", createdBy);
        if (!org || !inviter) throw new AccountActionError(404, "organisation not found");
        data = { kind, recipientName: recipient, organisationName: org.name, inviterName: inviter.username, expiresIn: "7 days", actionUrl };
      } else data = { kind, recipientName: recipient, expiresIn: kind === "password-reset" ? "30 minutes" : "24 hours", actionUrl };
      this.store.enqueue({ eventKey: `action:${id}`, kind, userId, orgId, actionId: id, expiresAt, payload: { to: email, data } });
      return id;
    });
  }

  inspect(token: unknown): AccountAction {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(token)) throw new AccountActionError(400, "This link is invalid or expired.");
    const action = this.store.db.get<AccountAction>(`SELECT id,kind,email,user_id,org_id,created_by,expires_at
      FROM notification_actions WHERE token_hash=? AND consumed_at IS NULL AND expires_at>?`, hashToken(token), this.store.now());
    if (!action) throw new AccountActionError(400, "This link is invalid or expired.");
    return action;
  }

  redeem(token: unknown, kind: ActionKind, input: { password?: unknown; username?: unknown; signedInUserId?: number }): void {
    if ((kind === "password-reset" || (kind === "invitation" && !input.signedInUserId)) &&
      (typeof input.password !== "string" || input.password.length < MIN_PASSWORD_LENGTH || input.password.length > 1024)) {
      throw new AccountActionError(400, `Use a password between ${MIN_PASSWORD_LENGTH} and 1024 characters.`);
    }
    this.store.transaction(() => {
      const action = this.inspect(token);
      if (action.kind !== kind) throw new AccountActionError(400, "This link is invalid or expired.");
      const now = this.store.now(); const db = this.store.db;
      if (kind === "invitation") {
        if (!db.get(`SELECT 1 FROM orgs o JOIN users u ON u.id=? WHERE o.id=? AND o.archived_at IS NULL
          AND u.deactivated_at IS NULL AND (u.is_admin=1 OR EXISTS(SELECT 1 FROM org_members WHERE user_id=u.id AND org_id=o.id))`, action.created_by, action.org_id)) {
          throw new AccountActionError(400, "This invitation is no longer available.");
        }
        let user = db.get<{ id: number; deactivated_at: number | null }>("SELECT id,deactivated_at FROM users WHERE email=?", action.email);
        if (user) {
          if (user.deactivated_at !== null || input.signedInUserId !== user.id) throw new AccountActionError(403, "Sign in with the invited account to accept.");
        } else {
          if (input.signedInUserId) throw new AccountActionError(403, "Sign out before creating the invited account.");
          if (typeof input.username !== "string" || !/^[A-Za-z0-9_.-]{3,64}$/.test(input.username)) throw new AccountActionError(400, "Use a username of 3–64 letters, numbers, dots, underscores or hyphens.");
          if (db.get("SELECT 1 FROM users WHERE username=?", input.username)) throw new AccountActionError(409, "That username is already in use.");
          db.run(`INSERT INTO users(username,email,password_hash,is_admin,created_at,email_verified_at) VALUES (?,?,?,0,?,?)`,
            input.username, action.email, hashPassword(input.password as string), now, now);
          user = db.get<{ id: number; deactivated_at: null }>("SELECT id,deactivated_at FROM users WHERE email=?", action.email)!;
        }
        db.run("INSERT OR IGNORE INTO org_members(user_id,org_id,created_at) VALUES (?,?,?)", user.id, action.org_id, now);
        db.run("UPDATE users SET email_verified_at=? WHERE id=?", now, user.id);
      } else {
        if (!db.get("SELECT 1 FROM users WHERE id=? AND email=? AND deactivated_at IS NULL", action.user_id, action.email)) throw new AccountActionError(400, "This link is invalid or expired.");
        if (kind === "email-verification") db.run("UPDATE users SET email_verified_at=? WHERE id=?", now, action.user_id);
        else {
          db.run("UPDATE users SET password_hash=?,session_version=session_version+1 WHERE id=?", hashPassword(input.password as string), action.user_id);
          db.run("DELETE FROM user_tokens WHERE user_id=?", action.user_id);
          const resets = db.all<{ id: string }>("SELECT id FROM notification_actions WHERE kind='password-reset' AND user_id=? AND consumed_at IS NULL", action.user_id);
          for (const reset of resets) this.store.cancelAction(reset.id);
        }
      }
      this.store.cancelAction(action.id, "accepted");
    });
  }
}
