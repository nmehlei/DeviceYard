import type { Db } from "../db/driver";
import type { UserRow } from "./rows";
import { hashPassword, verifyPassword } from "../passwords";

interface UserRecord {
  id: number;
  username: string;
  email: string;
  password_hash: string;
  is_admin: number;
  deactivated_at: number | null;
  created_at: number;
}

function toUser(record: UserRecord): UserRow {
  return {
    id: record.id,
    username: record.username,
    email: record.email,
    isAdmin: record.is_admin === 1,
    deactivatedAt: record.deactivated_at,
    createdAt: record.created_at,
  };
}

export class UserRepository {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now
  ) {}

  /** One-time backfill, mirroring DeviceRepository.seedIfEmpty: only ever
   * inserts when the table is empty, so a redeploy never re-creates or
   * fights an admin an operator already changed via the UI. */
  seedIfEmpty(username: string, email: string, password: string): void {
    const row = this.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM users");
    if ((row?.c ?? 0) > 0) return;
    this.create({ username, email, password, isAdmin: true });
  }

  create(opts: { username: string; email: string; password: string; isAdmin: boolean }): UserRow {
    const passwordHash = hashPassword(opts.password);
    this.db.run(
      "INSERT INTO users (username, email, password_hash, is_admin, deactivated_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)",
      opts.username,
      opts.email,
      passwordHash,
      opts.isAdmin ? 1 : 0,
      this.now()
    );
    return this.getByUsername(opts.username)!;
  }

  getById(id: number): UserRow | undefined {
    const record = this.db.get<UserRecord>("SELECT * FROM users WHERE id = ?", id);
    return record ? toUser(record) : undefined;
  }

  getByUsername(username: string): UserRow | undefined {
    const record = this.db.get<UserRecord>("SELECT * FROM users WHERE username = ?", username);
    return record ? toUser(record) : undefined;
  }

  list(): UserRow[] {
    return this.db.all<UserRecord>("SELECT * FROM users ORDER BY username ASC").map(toUser);
  }

  /** Returns undefined for a wrong password, an unknown username, OR a
   * deactivated account - all three fold into "invalid username or
   * password" at the API layer, so a caller can never distinguish a
   * deactivated account from a wrong password by response shape. */
  verifyCredentials(username: string, password: string): UserRow | undefined {
    const record = this.db.get<UserRecord>("SELECT * FROM users WHERE username = ?", username);
    if (!record || record.deactivated_at !== null) return undefined;
    if (!verifyPassword(password, record.password_hash)) return undefined;
    return toUser(record);
  }

  setAdmin(id: number, isAdmin: boolean): void {
    this.db.run("UPDATE users SET is_admin = ? WHERE id = ?", isAdmin ? 1 : 0, id);
  }

  setPassword(id: number, password: string): void {
    this.db.run("UPDATE users SET password_hash = ? WHERE id = ?", hashPassword(password), id);
  }

  sessionVersion(id: number): number | undefined {
    return this.db.get<{ session_version: number }>("SELECT session_version FROM users WHERE id=?", id)?.session_version;
  }

  deactivate(id: number): void {
    this.db.run("UPDATE users SET deactivated_at = ? WHERE id = ?", this.now(), id);
  }
}
