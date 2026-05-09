import Database from 'better-sqlite3';
import { Participant, PeerMode, RegisterInput, registerInputSchema } from '../types/schema.js';

/**
 * 参加者を登録する
 * @param db データベースインスタンス
 * @param input 登録情報（name は @ なし）
 * @param owner 所有者（GitHub login）。trust モードでは null を渡す。
 * @returns 登録された参加者情報（name は @ 付き）
 * @throws バリデーションエラー、または重複エラー
 */
export function registerParticipant(
  db: Database.Database,
  input: RegisterInput,
  owner: string | null = null
): Participant {
  // 入力バリデーション
  const validated = registerInputSchema.parse(input);

  // @ プレフィックスを付与
  const nameWithPrefix = `@${validated.name}`;
  const displayName = validated.display_name ?? null;
  const mode = validated.mode ?? null;

  try {
    // INSERT
    const stmt = db.prepare(`
      INSERT INTO participants (name, display_name, owner, mode)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run(nameWithPrefix, displayName, owner, mode);

    // 登録された参加者を取得して返す
    const result = db
      .prepare(`SELECT * FROM participants WHERE name = ?`)
      .get(nameWithPrefix) as Participant;

    return result;
  } catch (error) {
    // UNIQUE 制約違反（重複）
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
  name: string,
  mode: PeerMode | null
): void {
  db.prepare(`UPDATE participants SET mode = ? WHERE name = ?`).run(mode, name);
}

/**
 * 参加者の owner を設定する。NULL（未claimed）の場合のみ更新する（TOFU）。
 * 既に他人の owner が入っている場合は false を返す。
 * @returns true: 更新成功（または既に同じ owner）、false: 他人所有のため拒否
 */
export function claimOwnerIfUnowned(
  db: Database.Database,
  name: string,
  owner: string
): boolean {
  const current = db
    .prepare(`SELECT owner FROM participants WHERE name = ?`)
    .get(name) as { owner: string | null } | undefined;

  if (!current) return false;
  if (current.owner === owner) return true;
  if (current.owner === null) {
    db.prepare(`UPDATE participants SET owner = ? WHERE name = ?`).run(
      owner,
      name
    );
    return true;
  }
  return false;
}

/**
 * 全参加者を取得する (active のみ、soft delete されたものは除外)
 * @param db データベースインスタンス
 * @returns 参加者リスト（作成日時の降順）
 */
export function getParticipants(db: Database.Database): Participant[] {
  const stmt = db.prepare(`
    SELECT * FROM participants
    WHERE deleted_at IS NULL
    ORDER BY created_at DESC, rowid DESC
  `);

  return stmt.all() as Participant[];
}

/**
 * 特定の参加者を名前で取得する (active のみ、soft delete されたものは null 扱い)
 * @param db データベースインスタンス
 * @param name 参加者名（@ プレフィックス付き）
 * @returns 参加者情報、存在しない or 削除済の場合は null
 */
export function getParticipantByName(
  db: Database.Database,
  name: string
): Participant | null {
  const stmt = db.prepare(`
    SELECT * FROM participants WHERE name = ? AND deleted_at IS NULL
  `);

  const result = stmt.get(name) as Participant | undefined;
  return result ?? null;
}

/**
 * 参加者を soft delete する。FK 制約を破らずに論理削除するため、
 * 行は残るが deleted_at がセットされ getParticipants からは見えなくなる。
 * 既に削除済 / 存在しない場合は false。
 */
export function softDeleteParticipant(
  db: Database.Database,
  name: string
): boolean {
  const stmt = db.prepare(
    `UPDATE participants
       SET deleted_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
       WHERE name = ? AND deleted_at IS NULL`
  );
  const info = stmt.run(name);
  return info.changes > 0;
}

/**
 * deleted_at の有無に関わらず参加者を取得 (revive 判定用)。
 * 通常の場面では使わない、auth 層が「同じ owner が再接続したか」を
 * 判定するための内部 API。
 */
export function getParticipantByNameIncludingDeleted(
  db: Database.Database,
  name: string
): Participant | null {
  const stmt = db.prepare(`SELECT * FROM participants WHERE name = ?`);
  const result = stmt.get(name) as Participant | undefined;
  return result ?? null;
}

/**
 * 参加者を蘇生 (revive) する。owner が一致する soft-deleted 行に対してのみ
 * deleted_at = NULL に戻す。owner 不一致 / 既に active / 存在しない場合は false。
 */
export function reviveParticipant(
  db: Database.Database,
  name: string,
  owner: string
): boolean {
  const stmt = db.prepare(
    `UPDATE participants
       SET deleted_at = NULL
       WHERE name = ? AND owner = ? AND deleted_at IS NOT NULL`
  );
  const info = stmt.run(name, owner);
  return info.changes > 0;
}
