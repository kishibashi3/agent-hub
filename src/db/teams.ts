import Database from 'better-sqlite3';
import type { Team, CreateTeamInput, UpdateTeamInput } from '../types/schema.js';

/**
 * チームを作成する
 * - owner の自動追加
 * - @ プレフィックス付与
 * - members の検証と team_members 挿入
 * - 最低1人（owner）の制約を自動的に満たす
 * - トランザクションで原子性を保証
 */
export function createTeam(
  db: Database.Database,
  input: CreateTeamInput,
  requester: string
): Team {
  // @ プレフィックスを付与
  const teamName = input.name.startsWith('@') ? input.name : `@${input.name}`;
  const ownerName = requester.startsWith('@') ? requester : `@${requester}`;

  // requester が登録済みか確認
  const ownerExists = db
    .prepare('SELECT name FROM participants WHERE name = ?')
    .get(ownerName);
  if (!ownerExists) {
    throw new Error(`参加者 '${ownerName}' は登録されていません`);
  }

  // チーム名の重複確認
  const existingTeam = db
    .prepare('SELECT name FROM teams WHERE name = ?')
    .get(teamName);
  if (existingTeam) {
    throw new Error(`チーム '${teamName}' は既に存在します`);
  }

  // members の検証（@ プレフィックス付与）
  const memberNames = input.members.map((m: string) => m.startsWith('@') ? m : `@${m}`);
  
  // owner を自動追加（重複を避ける）
  const allMembers = Array.from(new Set([ownerName, ...memberNames]));

  // 全メンバーが登録済みか確認
  for (const member of allMembers) {
    const exists = db
      .prepare('SELECT name FROM participants WHERE name = ?')
      .get(member);
    if (!exists) {
      throw new Error(`参加者 '${member}' は登録されていません`);
    }
  }

  // トランザクション開始
  const insertTeam = db.prepare(
    'INSERT INTO teams (name, owner) VALUES (?, ?)'
  );
  const insertMember = db.prepare(
    'INSERT INTO team_members (team_name, member_name) VALUES (?, ?)'
  );

  const transaction = db.transaction(() => {
    insertTeam.run(teamName, ownerName);
    for (const member of allMembers) {
      insertMember.run(teamName, member);
    }
  });

  transaction();

  // 作成されたチームを取得
  const team = db
    .prepare('SELECT name, owner, created_at FROM teams WHERE name = ?')
    .get(teamName) as Team;

  return team;
}

/**
 * チームを更新する（メンバーの追加・削除）
 * - requester 権限チェック（owner のみ）
 * - add/remove ロジック（冪等性確保）
 * - owner 自身の remove 拒否
 * - 最終的に0人になる場合のエラーハンドリング
 * - トランザクションで原子性を保証
 */
export function updateTeam(
  db: Database.Database,
  input: UpdateTeamInput,
  requester: string
): { name: string; members: string[] } {
  const teamName = input.name.startsWith('@') ? input.name : `@${input.name}`;
  const requesterName = requester.startsWith('@') ? requester : `@${requester}`;

  // チームの存在確認と権限チェック
  const team = db
    .prepare('SELECT name, owner FROM teams WHERE name = ?')
    .get(teamName) as { name: string; owner: string } | undefined;

  if (!team) {
    throw new Error(`チーム '${teamName}' は存在しません`);
  }

  if (team.owner !== requesterName) {
    throw new Error(`チーム '${teamName}' を更新できるのはオーナー '${team.owner}' のみです`);
  }

  // add と remove の前処理
  const addNames = input.add ? input.add.map((m: string) => m.startsWith('@') ? m : `@${m}`) : [];
  const removeNames = input.remove ? input.remove.map((m: string) => m.startsWith('@') ? m : `@${m}`) : [];

  // owner 自身の削除を事前チェック
  if (removeNames.includes(requesterName)) {
    throw new Error('オーナーは自身をチームから削除できません');
  }

  // トランザクションで実行
  const transaction = db.transaction(() => {
    // add メンバーの処理
    if (addNames.length > 0) {
      // 全員が登録済みか確認
      for (const member of addNames) {
        const exists = db
          .prepare('SELECT name FROM participants WHERE name = ?')
          .get(member);
        if (!exists) {
          throw new Error(`参加者 '${member}' は登録されていません`);
        }
      }

      // 冪等性確保: INSERT OR IGNORE
      const insertMember = db.prepare(
        'INSERT OR IGNORE INTO team_members (team_name, member_name) VALUES (?, ?)'
      );
      for (const member of addNames) {
        insertMember.run(teamName, member);
      }
    }

    // remove メンバーの処理
    if (removeNames.length > 0) {
      // 削除前のメンバー数を確認
      const currentMembers = db
        .prepare('SELECT member_name FROM team_members WHERE team_name = ?')
        .all(teamName) as { member_name: string }[];
      
      const remainingMembers = currentMembers
        .map(m => m.member_name)
        .filter(m => !removeNames.includes(m));
      
      if (remainingMembers.length === 0) {
        throw new Error('チームには最低1人のメンバーが必要です（オーナーを含む）');
      }

      // 冪等性確保: DELETE（存在しなくてもエラーにならない）
      const deleteMember = db.prepare(
        'DELETE FROM team_members WHERE team_name = ? AND member_name = ?'
      );
      for (const member of removeNames) {
        deleteMember.run(teamName, member);
      }
    }
  });

  // トランザクション実行
  transaction();

  // 現在のメンバー一覧を取得
  const members = getTeamMembers(db, teamName);

  return { name: teamName, members };
}

/**
 * チームを削除する（冪等性確保）
 * - requester 権限チェック（owner のみ）
 * - CASCADE 削除確認（team_members は自動削除される）
 * - 存在しないチームの削除はエラーを返す
 * 
 * 注意: messages テーブルの recipient フィールドに外部キー制約がないため、
 * チームを削除してもメッセージは残ります。これは意図的な設計です。
 * 削除されたチームへのメッセージは履歴として保持されます。
 */
export function deleteTeam(
  db: Database.Database,
  teamName: string,
  requester: string
): { deleted: true } {
  const name = teamName.startsWith('@') ? teamName : `@${teamName}`;
  const requesterName = requester.startsWith('@') ? requester : `@${requester}`;

  // チームの存在確認と権限チェック
  const team = db
    .prepare('SELECT name, owner FROM teams WHERE name = ?')
    .get(name) as { name: string; owner: string } | undefined;

  if (!team) {
    throw new Error(`チーム '${name}' は存在しません`);
  }

  if (team.owner !== requesterName) {
    throw new Error(`チーム '${name}' を削除できるのはオーナー '${team.owner}' のみです`);
  }

  // チームを削除（team_members は CASCADE で自動削除）
  db.prepare('DELETE FROM teams WHERE name = ?').run(name);

  return { deleted: true };
}

/**
 * 全チームを取得する
 */
export function getTeams(db: Database.Database): Team[] {
  const teams = db
    .prepare('SELECT name, owner, created_at FROM teams ORDER BY created_at DESC')
    .all() as Team[];
  return teams;
}

/**
 * チームのメンバー一覧を取得する
 */
export function getTeamMembers(db: Database.Database, teamName: string): string[] {
  const name = teamName.startsWith('@') ? teamName : `@${teamName}`;
  
  const members = db
    .prepare('SELECT member_name FROM team_members WHERE team_name = ? ORDER BY joined_at')
    .all(name) as { member_name: string }[];
  
  return members.map(m => m.member_name);
}

/**
 * 指定したユーザーがチームメンバーかどうか確認する
 */
export function isTeamMember(
  db: Database.Database,
  teamName: string,
  memberName: string
): boolean {
  const team = teamName.startsWith('@') ? teamName : `@${teamName}`;
  const member = memberName.startsWith('@') ? memberName : `@${memberName}`;
  
  const result = db
    .prepare('SELECT 1 FROM team_members WHERE team_name = ? AND member_name = ?')
    .get(team, member);
  
  return result !== undefined;
}
