import type { Database } from 'better-sqlite3';

/**
 * default tenant 名 (= X-Tenant-Id 未指定時、雑談室)。
 */
export const DEFAULT_TENANT = 'default';

/**
 * tenant 名のバリデーション。英数字 / hyphen / underscore のみ、1-64 文字。
 * SQL 注入や予期せぬ文字列を弾く。
 */
export function isValidTenantDomain(domain: string): boolean {
  return /^[a-z0-9_-]{1,64}$/i.test(domain);
}

/**
 * tenant 登録情報。
 * - domain = X-Tenant-Id header 値 (= tenant 識別子)
 * - owner = TOFU で claim した GitHub login (NULL = 雑談室、誰でも入れる)
 */
export interface TenantRow {
  domain: string;
  owner: string | null;
  created_at: string;
}

/**
 * tenant の現在の所有者を返す。未登録なら undefined。
 * default tenant は migration で pre-create されてるので owner=NULL の row が必ずある。
 */
export function getTenant(
  db: Database,
  domain: string
): TenantRow | undefined {
  return db
    .prepare('SELECT * FROM tenants WHERE domain = ?')
    .get(domain) as TenantRow | undefined;
}

/**
 * tenant を TOFU claim する。
 * 既存 row があれば何もしない (= owner が既に NULL でも上書きしない、
 * NULL は「open lobby」を意味するため明示的な意図表明)。
 */
export function claimTenantIfMissing(
  db: Database,
  domain: string,
  owner: string
): void {
  db.prepare(
    `INSERT INTO tenants (domain, owner) VALUES (?, ?)
     ON CONFLICT(domain) DO NOTHING`
  ).run(domain, owner);
}

/**
 * deployment が初期化されているか = default tenant に `@admin` (deletion されてない) が
 * 存在しているか。
 *
 * CE deployment の operator は default tenant の @admin。これが claim されるまでは
 * named tenant の access も default tenant の非 @admin claim も全部塞ぐことで、
 * 「先に operator が確立される」を強制する (squat 防止 + bootstrap 順序保証)。
 */
export function isDeploymentInitialized(db: Database): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM participants
       WHERE tenant_id = ? AND name = ? AND deleted_at IS NULL
       LIMIT 1`
    )
    .get(DEFAULT_TENANT, '@admin');
  return row !== undefined;
}
