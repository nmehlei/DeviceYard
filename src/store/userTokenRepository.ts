import type { Db } from "../db/driver";
import type { UserTokenRow } from "./rows";
import { generateToken, hashToken, encryptToken, decryptToken } from "../tokenCrypto";

interface UserTokenRecord {
  id: number;
  user_id: number;
  label: string;
  token_encrypted: string;
  token_hash: string;
  created_at: number;
  last_used_at: number | null;
}

/** Deliberately a close sibling of OrgTokenRepository: same encrypt-and-hash
 * storage, same revoke-by-delete, same retrievable `value`. Reviewers should
 * be able to diff the two files and see only the key change from org to
 * user. */
export class UserTokenRepository {
  constructor(
    private readonly db: Db,
    private readonly encryptionKey: string,
    private readonly now: () => number = Date.now
  ) {}

  private toRow(record: UserTokenRecord): UserTokenRow {
    return {
      id: record.id,
      userId: record.user_id,
      label: record.label,
      value: decryptToken(record.token_encrypted, this.encryptionKey),
      createdAt: record.created_at,
      lastUsedAt: record.last_used_at,
    };
  }

  create(userId: number, label: string, rawToken: string): UserTokenRow {
    const hash = hashToken(rawToken);
    this.db.run(
      "INSERT INTO user_tokens (user_id, label, token_encrypted, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, NULL)",
      userId,
      label,
      encryptToken(rawToken, this.encryptionKey),
      hash,
      this.now()
    );
    return this.toRow(this.db.get<UserTokenRecord>("SELECT * FROM user_tokens WHERE token_hash = ?", hash)!);
  }

  generateAndCreate(userId: number, label: string): UserTokenRow {
    return this.create(userId, label, generateToken());
  }

  list(userId: number): UserTokenRow[] {
    return this.db
      .all<UserTokenRecord>("SELECT * FROM user_tokens WHERE user_id = ? ORDER BY created_at ASC", userId)
      .map((r) => this.toRow(r));
  }

  /** Scoped to userId for the same reason OrgTokenRepository.revoke is scoped
   * to orgId: nobody revokes another person's token by guessing its id. */
  revoke(tokenId: number, userId: number): void {
    this.db.run("DELETE FROM user_tokens WHERE id = ? AND user_id = ?", tokenId, userId);
  }

  /** The PAT bearer-auth lookup: one indexed hash comparison, never a
   * decrypt, joined against users so a deactivated account's tokens stop
   * authenticating immediately - the same property the org-token lookup gets
   * from joining archived orgs. */
  findActiveByRawToken(rawToken: string): { id: number; userId: number } | undefined {
    const row = this.db.get<{ id: number; user_id: number }>(
      `SELECT user_tokens.id AS id, user_tokens.user_id AS user_id FROM user_tokens
       JOIN users ON users.id = user_tokens.user_id
       WHERE user_tokens.token_hash = ? AND users.deactivated_at IS NULL`,
      hashToken(rawToken)
    );
    return row ? { id: row.id, userId: row.user_id } : undefined;
  }

  touchLastUsed(tokenId: number): void {
    this.db.run("UPDATE user_tokens SET last_used_at = ? WHERE id = ?", this.now(), tokenId);
  }
}
