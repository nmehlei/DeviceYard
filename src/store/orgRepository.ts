import type { Db } from "../db/driver";
import type { OrgRow, UserRow } from "./rows";

interface OrgRecord {
  id: number;
  name: string;
  archived_at: number | null;
  created_at: number;
}

interface UserRecord {
  id: number;
  username: string;
  email: string;
  password_hash: string;
  is_admin: number;
  deactivated_at: number | null;
  created_at: number;
}

function toOrg(record: OrgRecord): OrgRow {
  return { id: record.id, name: record.name, archivedAt: record.archived_at, createdAt: record.created_at };
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

export class OrgRepository {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now
  ) {}

  /** One-time backfill from TOKENS_JSON's keys, mirroring
   * DeviceRepository.seedIfEmpty - only inserts when orgs is empty, and adds
   * initialMemberUserId (the bootstrap admin) as every seeded org's first
   * member so there is never a dead-end org with zero members. */
  seedIfEmpty(names: string[], initialMemberUserId: number): void {
    const row = this.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM orgs");
    if ((row?.c ?? 0) > 0) return;
    for (const name of names) {
      this.create(name, [initialMemberUserId]);
    }
  }

  create(name: string, initialMemberUserIds: number[]): OrgRow {
    this.db.run("INSERT INTO orgs (name, archived_at, created_at) VALUES (?, NULL, ?)", name, this.now());
    const org = this.getByName(name)!;
    for (const userId of initialMemberUserIds) {
      this.addMember(org.id, userId);
    }
    return org;
  }

  getById(id: number): OrgRow | undefined {
    const record = this.db.get<OrgRecord>("SELECT * FROM orgs WHERE id = ?", id);
    return record ? toOrg(record) : undefined;
  }

  getByName(name: string): OrgRow | undefined {
    const record = this.db.get<OrgRecord>("SELECT * FROM orgs WHERE name = ?", name);
    return record ? toOrg(record) : undefined;
  }

  /** Every org, active or archived - the admin org-management page's view. */
  list(): OrgRow[] {
    return this.db.all<OrgRecord>("SELECT * FROM orgs ORDER BY name ASC").map(toOrg);
  }

  /** Active orgs a given user belongs to - the org switcher's view. An
   * archived org disappears from here even for a former member, per the
   * spec: "Archiving an org makes it disappear from every member's org
   * switcher." */
  listForUser(userId: number): OrgRow[] {
    return this.db
      .all<OrgRecord>(
        `SELECT orgs.* FROM orgs
         JOIN org_members ON org_members.org_id = orgs.id
         WHERE org_members.user_id = ? AND orgs.archived_at IS NULL
         ORDER BY orgs.name ASC`,
        userId
      )
      .map(toOrg);
  }

  rename(id: number, name: string): void {
    this.db.run("UPDATE orgs SET name = ? WHERE id = ?", name, id);
  }

  archive(id: number): void {
    this.db.run("UPDATE orgs SET archived_at = ? WHERE id = ?", this.now(), id);
  }

  isMember(userId: number, orgId: number): boolean {
    const row = this.db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM org_members WHERE user_id = ? AND org_id = ?",
      userId,
      orgId
    );
    return (row?.c ?? 0) > 0;
  }

  listMembers(orgId: number): UserRow[] {
    return this.db
      .all<UserRecord>(
        `SELECT users.* FROM users
         JOIN org_members ON org_members.user_id = users.id
         WHERE org_members.org_id = ?
         ORDER BY users.username ASC`,
        orgId
      )
      .map(toUser);
  }

  addMember(orgId: number, userId: number): void {
    this.db.run(
      "INSERT OR IGNORE INTO org_members (user_id, org_id, created_at) VALUES (?, ?, ?)",
      userId,
      orgId,
      this.now()
    );
  }

  removeMember(orgId: number, userId: number): void {
    this.db.run("DELETE FROM org_members WHERE user_id = ? AND org_id = ?", userId, orgId);
  }
}
