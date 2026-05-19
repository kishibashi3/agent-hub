import Database from 'better-sqlite3';
import { Participant, PeerMode, RegisterInput, registerInputSchema } from '../types/schema.js';

/**
 * 参加者を登録する (tenant 内 unique)
 */
export function registerParticipant(
  db: Database.Database,
  tenantId: string,
  input: RegisterInput,
  owner: string | null = null
): Participant {
  const validated = registerInputSchema.parse(input);

  const nameWithPrefix = `@${validated.name}`;
  const displayName = validated.display_name ?? null;
  const mode = validated.mode ?? null;

  try {
    db.prepare(
      `INSERT INTO participants (tenant_id, name, display_name, owner, mode)
       VALUES (?, ?, ?, ?, ?)`
    ).run(tenantId, nameWithPrefix, displayName, owner, mode);

    const result = db
      .prepare(
        `SELECT * FROM participants WHERE tenant_id = ? AND name = ?`
      )
      .get(tenantId, nameWithPrefix) as Participant;

    return result;
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
      throw new Error(`参加者 '${nameWithPrefix}' は既に登録されています`);
    }
    throw error;
  }
}

/**
 * 参加者の mode を更新する。re-register での宣言更新用。
 * NULL 指定で「未宣言」に戻すこともできる。
 */
export function updateParticipantMode(
  db: Database.Database,
  tenantId: string,
  name: string,
  mode: PeerMode | null
): void {
  db.prepare(
    `UPDATE participants SET mode = ? WHERE tenant_id = ? AND name = ?`
  ).run(mode, tenantId, name);
}

/**
 * 参加者の display_name を更新する。re-register で表示名を変更する用。
 * NULL 指定で「未設定」に戻すこともできる。
 */
export function updateParticipantDisplayName(
  db: Database.Database,
  tenantId: string,
  name: string,
  displayName: string | null
): void {
  db.prepare(
    `UPDATE participants SET display_name = ? WHERE tenant_id = ? AND name = ?`
  ).run(displayName, tenantId, name);
}

/**
 * 参加者の owner を設定する。NULL（未claimed）の場合のみ更新する（TOFU）。
 * 既に他人の owner が入っている場合は false を返す。
 */
export function claimOwnerIfUnowned(
  db: Database.Database,
  tenantId: string,
  name: string,
  owner: string
): boolean {
  const current = db
    .prepare(
      `SELECT owner FROM participants WHERE tenant_id = ? AND name = ?`
    )
    .get(tenantId, name) as { owner: string | null } | undefined;

  if (!current) return false;
  if (current.owner === owner) return true;
  if (current.owner === null) {
    db.prepare(
      `UPDATE participants SET owner = ? WHERE tenant_id = ? AND name = ?`
    ).run(owner, tenantId, name);
    return true;
  }
  return false;
}

/**
 * 全参加者を取得する (active のみ、tenant 内、作成日時の降順)
 */
export function getParticipants(
  db: Database.Database,
  tenantId: string
): Participant[] {
  const stmt = db.prepare(
    `SELECT * FROM participants
     WHERE tenant_id = ? AND deleted_at IS NULL
     ORDER BY created_at DESC, rowid DESC`
  );
  return stmt.all(tenantId) as Participant[];
}

/**
 * 特定の参加者を名前で取得する (active のみ、tenant 内)
 */
export function getParticipantByName(
  db: Database.Database,
  tenantId: string,
  name: string
): Participant | null {
  const stmt = db.prepare(
    `SELECT * FROM participants
     WHERE tenant_id = ? AND name = ? AND deleted_at IS NULL`
  );
  const result = stmt.get(tenantId, name) as Participant | undefined;
  return result ?? null;
}

/**
 * 参加者を soft delete する。
 */
export function softDeleteParticipant(
  db: Database.Database,
  tenantId: string,
  name: string
): boolean {
  const stmt = db.prepare(
    `UPDATE participants
       SET deleted_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
       WHERE tenant_id = ? AND name = ? AND deleted_at IS NULL`
  );
  const info = stmt.run(tenantId, name);
  return info.changes > 0;
}

/**
 * deleted_at の有無に関わらず参加者を取得 (revive 判定用、auth 層内部 API)。
 */
export function getParticipantByNameIncludingDeleted(
  db: Database.Database,
  tenantId: string,
  name: string
): Participant | null {
  const stmt = db.prepare(
    `SELECT * FROM participants WHERE tenant_id = ? AND name = ?`
  );
  const result = stmt.get(tenantId, name) as Participant | undefined;
  return result ?? null;
}

/**
 * 参加者を蘇生 (revive) する。owner が一致する soft-deleted 行に対してのみ
 * deleted_at = NULL に戻す。
 */
export function reviveParticipant(
  db: Database.Database,
  tenantId: string,
  name: string,
  owner: string
): boolean {
  const stmt = db.prepare(
    `UPDATE participants
       SET deleted_at = NULL
       WHERE tenant_id = ? AND name = ? AND owner = ? AND deleted_at IS NOT NULL`
  );
  const info = stmt.run(tenantId, name, owner);
  return info.changes > 0;
}

/**
 * 同じ handle name + owner で **excludeTenantId 以外** に存在する tenant の domain 一覧を返す
 * (= issue #28 ghost session detection の cross-tenant lookup)。
 *
 * 用途: session が default tenant に着地した時、 同じ owner が同じ handle 名で
 * named tenant に registered なら 「AGENT_HUB_TENANT 環境変数の伝播失敗かも?」
 * と server log で WARN するための signal source。
 *
 * - **owner 完全一致 required**: name のみ一致 (= 別 owner の同名 handle、 multi-tenant
 *   設計上は別 entity) は match させない (= false positive 防止)
 * - soft-deleted (= deleted_at NOT NULL) は除外
 * - return は tenant_id 昇順、 空配列の場合は他に見つからない (= warn 対象外)
 *
 * 例: owner=alice が default + tenant-a 両方に @bridge-claude 登録 → default 接続時
 *      `findOtherTenantsForHandleAndOwner(db, '@bridge-claude', 'alice', 'default')` → `['tenant-a']`
 */
export function findOtherTenantsForHandleAndOwner(
  db: Database.Database,
  handleName: string,
  owner: string,
  excludeTenantId: string
): string[] {
  const rows = db
    .prepare(
      `SELECT tenant_id FROM participants
       WHERE name = ?
         AND owner = ?
         AND tenant_id != ?
         AND deleted_at IS NULL
       ORDER BY tenant_id`
    )
    .all(handleName, owner, excludeTenantId) as { tenant_id: string }[];
  return rows.map((r) => r.tenant_id);
}
