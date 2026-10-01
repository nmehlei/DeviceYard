import type { Db } from "../db/driver";
import type { OrgTokenRow } from "./rows";
import { generateToken, hashToken, encryptToken, decryptToken } from "../tokenCrypto";

interface OrgTokenRecord {
  id: number;
  org_id: number;
  label: string;
  token_encrypted: string;
  token_hash: string;
  created_at: number;
  created_by_user_id: number | null;
}

export class OrgTokenRepository {
  constructor(
    private readonly db: Db,
    private readonly encryptionKey: string,
    private readonly now: () => number = Date.now
  ) {}

  private toRow(record: OrgTokenRecord): OrgTokenRow {
    return {
      id: record.id,
      orgId: record.org_id,
      label: record.label,
      value: decryptToken(record.token_encrypted, this.encryptionKey),
      createdAt: record.created_at,
      createdByUserId: record.created_by_user_id,
    };
  }

  /** One-time backfill from TOKENS_JSON, mirroring the other repositories'
   * seedIfEmpty: only runs when org_tokens is empty. resolveOrgId looks up
   * each TOKENS_JSON key against the (already-seeded, by this point in
   * boot) orgs table - a key with no matching org is skipped rather than
   * throwing, since OrgRepository.seedIfEmpty and this call both source
   * their names from the same TOKENS_JSON, but defensively decoupled. */
  seedIfEmpty(tokensByOrg: Record<string, string>, resolveOrgId: (orgName: string) => number | undefined): void {
    const row = this.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM org_tokens");
    if ((row?.c ?? 0) > 0) return;
    for (const [name, token] of Object.entries(tokensByOrg)) {
      const orgId = resolveOrgId(name);
      if (orgId === undefined) continue;
      this.create(orgId, "default", token, null);
    }
  }

  create(orgId: number, label: string, rawToken: string, createdByUserId: number | null): OrgTokenRow {
    const encrypted = encryptToken(rawToken, this.encryptionKey);
    const hash = hashToken(rawToken);
    this.db.run(
      "INSERT INTO org_tokens (org_id, label, token_encrypted, token_hash, created_at, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?)",
      orgId,
      label,
      encrypted,
      hash,
      this.now(),
      createdByUserId
    );
    const record = this.db.get<OrgTokenRecord>("SELECT * FROM org_tokens WHERE token_hash = ?", hash)!;
    return this.toRow(record);
  }

  generateAndCreate(orgId: number, label: string, createdByUserId: number | null): OrgTokenRow {
    return this.create(orgId, label, generateToken(), createdByUserId);
  }

  list(orgId: number): OrgTokenRow[] {
    return this.db
      .all<OrgTokenRecord>("SELECT * FROM org_tokens WHERE org_id = ? ORDER BY created_at ASC", orgId)
      .map((r) => this.toRow(r));
  }

  /** Scoped to orgId so an org member can never revoke another org's token
   * by guessing its numeric id. */
  revoke(tokenId: number, orgId: number): void {
    this.db.run("DELETE FROM org_tokens WHERE id = ? AND org_id = ?", tokenId, orgId);
  }

  /** The CI bearer-auth lookup path: one indexed hash comparison, never a
   * decrypt, and joined against orgs so an archived org's tokens stop
   * authenticating immediately (same effect as if the token never existed). */
  findActiveOrgNameByRawToken(rawToken: string): string | undefined {
    const hash = hashToken(rawToken);
    const row = this.db.get<{ name: string }>(
      `SELECT orgs.name AS name FROM org_tokens
       JOIN orgs ON orgs.id = org_tokens.org_id
       WHERE org_tokens.token_hash = ? AND orgs.archived_at IS NULL`,
      hash
    );
    return row?.name;
  }
}
