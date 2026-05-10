import Database from 'better-sqlite3';
import type { Team, CreateTeamInput, UpdateTeamInput } from '../types/schema.js';

/**
 * チームを作成する (tenant 内 unique)
 */
export function createTeam(
  db: Database.Database,
  tenantId: string,
  input: CreateTeamInput,
  requester: string
): Team {
  const teamName = input.name.startsWith('@') ? input.name : `@${input.name}`;
  const ownerName = requester.startsWith('@') ? requester : `@${requester}`;

  const ownerExists = db
    .prepare('SELECT name FROM participants WHERE tenant_id = ? AND name = ?')
    .get(tenantId, ownerName);
  if (!ownerExists) {
    throw new Error(`参加者 '${ownerName}' は登録されていません`);
  }

  const existingTeam = db
    .prepare('SELECT name FROM teams WHERE tenant_id = ? AND name = ?')
    .get(tenantId, teamName);
  if (existingTeam) {
    throw new Error(`チーム '${teamName}' は既に存在します`);
  }

  const memberNames = input.members.map((m: string) =>
    m.startsWith('@') ? m : `@${m}`
  );
  const allMembers = Array.from(new Set([ownerName, ...memberNames]));

  for (const member of allMembers) {
    const exists = db
      .prepare('SELECT name FROM participants WHERE tenant_id = ? AND name = ?')
      .get(tenantId, member);
    if (!exists) {
      throw new Error(`参加者 '${member}' は登録されていません`);
    }
  }

  const insertTeam = db.prepare(
    'INSERT INTO teams (tenant_id, name, owner) VALUES (?, ?, ?)'
  );
  const insertMember = db.prepare(
    'INSERT INTO team_members (tenant_id, team_name, member_name) VALUES (?, ?, ?)'
  );

  const transaction = db.transaction(() => {
    insertTeam.run(tenantId, teamName, ownerName);
    for (const member of allMembers) {
      insertMember.run(tenantId, teamName, member);
    }
  });

  transaction();

  const team = db
    .prepare('SELECT name, owner, created_at FROM teams WHERE tenant_id = ? AND name = ?')
    .get(tenantId, teamName) as Team;

  return team;
}

/**
 * チームを更新する（メンバーの追加・削除）
 */
export function updateTeam(
  db: Database.Database,
  tenantId: string,
  input: UpdateTeamInput,
  requester: string
): { name: string; members: string[] } {
  const teamName = input.name.startsWith('@') ? input.name : `@${input.name}`;
  const requesterName = requester.startsWith('@') ? requester : `@${requester}`;

  const team = db
    .prepare('SELECT name, owner FROM teams WHERE tenant_id = ? AND name = ?')
    .get(tenantId, teamName) as { name: string; owner: string } | undefined;

  if (!team) {
    throw new Error(`チーム '${teamName}' は存在しません`);
  }

  if (team.owner !== requesterName) {
    throw new Error(
      `チーム '${teamName}' を更新できるのはオーナー '${team.owner}' のみです`
    );
  }

  const addNames = input.add
    ? input.add.map((m: string) => (m.startsWith('@') ? m : `@${m}`))
    : [];
  const removeNames = input.remove
    ? input.remove.map((m: string) => (m.startsWith('@') ? m : `@${m}`))
    : [];

  if (removeNames.includes(requesterName)) {
    throw new Error('オーナーは自身をチームから削除できません');
  }

  const transaction = db.transaction(() => {
    if (addNames.length > 0) {
      for (const member of addNames) {
        const exists = db
          .prepare('SELECT name FROM participants WHERE tenant_id = ? AND name = ?')
          .get(tenantId, member);
        if (!exists) {
          throw new Error(`参加者 '${member}' は登録されていません`);
        }
      }

      const insertMember = db.prepare(
        'INSERT OR IGNORE INTO team_members (tenant_id, team_name, member_name) VALUES (?, ?, ?)'
      );
      for (const member of addNames) {
        insertMember.run(tenantId, teamName, member);
      }
    }

    if (removeNames.length > 0) {
      const currentMembers = db
        .prepare(
          'SELECT member_name FROM team_members WHERE tenant_id = ? AND team_name = ?'
        )
        .all(tenantId, teamName) as { member_name: string }[];

      const remainingMembers = currentMembers
        .map((m) => m.member_name)
        .filter((m) => !removeNames.includes(m));

      if (remainingMembers.length === 0) {
        throw new Error('チームには最低1人のメンバーが必要です（オーナーを含む）');
      }

      const deleteMember = db.prepare(
        'DELETE FROM team_members WHERE tenant_id = ? AND team_name = ? AND member_name = ?'
      );
      for (const member of removeNames) {
        deleteMember.run(tenantId, teamName, member);
      }
    }
  });

  transaction();

  const members = getTeamMembers(db, tenantId, teamName);

  return { name: teamName, members };
}

/**
 * チームを削除する（CASCADE で team_members も削除）
 */
export function deleteTeam(
  db: Database.Database,
  tenantId: string,
  teamName: string,
  requester: string
): { deleted: true } {
  const name = teamName.startsWith('@') ? teamName : `@${teamName}`;
  const requesterName = requester.startsWith('@') ? requester : `@${requester}`;

  const team = db
    .prepare('SELECT name, owner FROM teams WHERE tenant_id = ? AND name = ?')
    .get(tenantId, name) as { name: string; owner: string } | undefined;

  if (!team) {
    throw new Error(`チーム '${name}' は存在しません`);
  }

  if (team.owner !== requesterName) {
    throw new Error(
      `チーム '${name}' を削除できるのはオーナー '${team.owner}' のみです`
    );
  }

  db.prepare('DELETE FROM teams WHERE tenant_id = ? AND name = ?').run(
    tenantId,
    name
  );

  return { deleted: true };
}

/**
 * 全チームを取得する (tenant 内)
 */
export function getTeams(db: Database.Database, tenantId: string): Team[] {
  const teams = db
    .prepare(
      'SELECT name, owner, created_at FROM teams WHERE tenant_id = ? ORDER BY created_at DESC'
    )
    .all(tenantId) as Team[];
  return teams;
}

/**
 * チームのメンバー一覧を取得する
 */
export function getTeamMembers(
  db: Database.Database,
  tenantId: string,
  teamName: string
): string[] {
  const name = teamName.startsWith('@') ? teamName : `@${teamName}`;

  const members = db
    .prepare(
      'SELECT member_name FROM team_members WHERE tenant_id = ? AND team_name = ? ORDER BY joined_at'
    )
    .all(tenantId, name) as { member_name: string }[];

  return members.map((m) => m.member_name);
}

/**
 * 指定したユーザーがチームメンバーかどうか確認する
 */
export function isTeamMember(
  db: Database.Database,
  tenantId: string,
  teamName: string,
  memberName: string
): boolean {
  const team = teamName.startsWith('@') ? teamName : `@${teamName}`;
  const member = memberName.startsWith('@') ? memberName : `@${memberName}`;

  const result = db
    .prepare(
      'SELECT 1 FROM team_members WHERE tenant_id = ? AND team_name = ? AND member_name = ?'
    )
    .get(tenantId, team, member);

  return result !== undefined;
}
