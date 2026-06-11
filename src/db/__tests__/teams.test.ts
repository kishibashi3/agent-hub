import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  createTeam,
  updateTeam,
  deleteTeam,
  getTeams,
  getTeamMembers,
  isTeamMember,
} from '../teams';

// スキーマファイルから SQL を読み込む
import { readFileSync } from 'fs';
import { join } from 'path';

const schemaSQL = readFileSync(
  join(__dirname, '../schema.sql'),
  'utf-8'
);

/**
 * テスト用のインメモリ DB を初期化する
 */
function setupTestDB(): Database.Database {
  const db = new Database(':memory:');
  db.exec(schemaSQL);
  return db;
}

/**
 * テスト用の参加者を登録する
 * participants.ts の registerParticipant を使わず、直接 INSERT することで
 * participants.ts への依存を避ける
 */
function registerParticipants(db: Database.Database, names: string[]) {
  const insert = db.prepare(
    'INSERT INTO participants (tenant_id, name, display_name) VALUES (?, ?, ?)'
  );
  for (const name of names) {
    const fullName = name.startsWith('@') ? name : `@${name}`;
    insert.run('default', fullName, null);
  }
}

describe('teams CRUD', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupTestDB();
  });

  describe('createTeam - 正常系', () => {
    it('チームを作成し、owner が自動的にメンバーに追加される', () => {
      // 参加者を登録
      registerParticipants(db, ['alice', 'bob', 'charlie']);

      // チームを作成
      const team = createTeam(
        db,
        'default',
        { name: 'project-x', members: ['bob', 'charlie'] },
        'alice'
      );

      expect(team.name).toBe('@project-x');
      expect(team.owner).toBe('@alice');

      // メンバーを確認（owner も含まれる）
      const members = getTeamMembers(db, 'default', '@project-x');
      expect(members).toHaveLength(3);
      expect(members).toContain('@alice');
      expect(members).toContain('@bob');
      expect(members).toContain('@charlie');
    });

    it('@ プレフィックスが自動的に付与される', () => {
      registerParticipants(db, ['alice']);

      const team = createTeam(
        db,
        'default',
        { name: 'test-team', members: [] },
        'alice'
      );

      expect(team.name).toBe('@test-team');
      expect(team.owner).toBe('@alice');
    });

    it('members が空でも owner が自動的にメンバーになる（最低1人制約）', () => {
      registerParticipants(db, ['alice']);

      const team = createTeam(
        db,
        'default',
        { name: 'solo-team', members: [] },
        'alice'
      );

      const members = getTeamMembers(db, 'default', 'solo-team');
      expect(members).toHaveLength(1);
      expect(members).toContain('@alice');
    });

    it('owner が members に含まれていても重複しない', () => {
      registerParticipants(db, ['alice', 'bob']);

      const team = createTeam(
        db,
        'default',
        { name: 'team', members: ['alice', 'bob'] },
        'alice'
      );

      const members = getTeamMembers(db, 'default', 'team');
      expect(members).toHaveLength(2);
      expect(members.filter(m => m === '@alice')).toHaveLength(1);
    });
  });

  describe('createTeam - 異常系', () => {
    it('owner が未登録の場合はエラー', () => {
      expect(() => {
        createTeam(
          db,
          'default',
          { name: 'team', members: [] },
          'unknown'
        );
      }).toThrow("参加者 '@unknown' は登録されていません");
    });

    it('存在しないメンバーを指定するとエラー', () => {
      registerParticipants(db, ['alice']);

      expect(() => {
        createTeam(
          db,
          'default',
          { name: 'team', members: ['bob'] },
          'alice'
        );
      }).toThrow("参加者 '@bob' は登録されていません");
    });

    it('同名のチームが既に存在する場合はエラー', () => {
      registerParticipants(db, ['alice']);

      createTeam(
        db,
        'default',
        { name: 'team', members: [] },
        'alice'
      );

      expect(() => {
        createTeam(
          db,
          'default',
          { name: 'team', members: [] },
          'alice'
        );
      }).toThrow("チーム '@team' は既に存在します");
    });
  });

  describe('updateTeam - 正常系', () => {
    it('owner がメンバーを追加できる', () => {
      registerParticipants(db, ['alice', 'bob', 'charlie', 'david']);
      createTeam(
        db,
        'default',
        { name: 'team', members: ['bob'] },
        'alice'
      );

      const result = updateTeam(
        db,
        'default',
        { name: 'team', add: ['charlie', 'david'] },
        'alice'
      );

      expect(result.members).toHaveLength(4);
      expect(result.members).toContain('@charlie');
      expect(result.members).toContain('@david');
    });

    it('owner がメンバーを削除できる', () => {
      registerParticipants(db, ['alice', 'bob', 'charlie']);
      createTeam(
        db,
        'default',
        { name: 'team', members: ['bob', 'charlie'] },
        'alice'
      );

      const result = updateTeam(
        db,
        'default',
        { name: 'team', remove: ['bob'] },
        'alice'
      );

      expect(result.members).toHaveLength(2);
      expect(result.members).not.toContain('@bob');
      expect(result.members).toContain('@alice');
      expect(result.members).toContain('@charlie');
    });

    it('既に存在するメンバーを追加しても冪等的に成功する', () => {
      registerParticipants(db, ['alice', 'bob']);
      createTeam(
        db,
        'default',
        { name: 'team', members: ['bob'] },
        'alice'
      );

      // bob を再度追加
      const result = updateTeam(
        db,
        'default',
        { name: 'team', add: ['bob'] },
        'alice'
      );

      const members = result.members;
      expect(members).toHaveLength(2);
      expect(members.filter(m => m === '@bob')).toHaveLength(1);
    });

    it('存在しないメンバーを削除しても冪等的に成功する', () => {
      registerParticipants(db, ['alice', 'bob']);
      createTeam(
        db,
        'default',
        { name: 'team', members: ['bob'] },
        'alice'
      );

      // charlie は存在しないが、削除操作はエラーにならない
      const result = updateTeam(
        db,
        'default',
        { name: 'team', remove: ['charlie'] },
        'alice'
      );

      expect(result.members).toHaveLength(2);
    });
  });

  describe('updateTeam - 異常系', () => {
    it('owner 自身を削除しようとするとエラー', () => {
      registerParticipants(db, ['alice', 'bob']);
      createTeam(
        db,
        'default',
        { name: 'team', members: ['bob'] },
        'alice'
      );

      expect(() => {
        updateTeam(
          db,
          'default',
          { name: 'team', remove: ['alice'] },
          'alice'
        );
      }).toThrow('オーナーは自身をチームから削除できません');
    });

    it('最後のメンバー（owner）を削除しようとするとエラー', () => {
      registerParticipants(db, ['alice', 'bob']);
      createTeam(
        db,
        'default',
        { name: 'team', members: ['bob'] },
        'alice'
      );

      // bob を削除してから alice を削除しようとする
      updateTeam(
        db,
        'default',
        { name: 'team', remove: ['bob'] },
        'alice'
      );

      expect(() => {
        updateTeam(
          db,
          'default',
          { name: 'team', remove: ['alice'] },
          'alice'
        );
      }).toThrow('オーナーは自身をチームから削除できません');
    });

    it('owner 以外が更新しようとするとエラー', () => {
      registerParticipants(db, ['alice', 'bob', 'charlie']);
      createTeam(
        db,
        'default',
        { name: 'team', members: ['bob', 'charlie'] },
        'alice'
      );

      expect(() => {
        updateTeam(
          db,
          'default',
          { name: 'team', add: ['alice'] },
          'bob'
        );
      }).toThrow("チーム '@team' を更新できるのはオーナー '@alice' のみです");
    });

    it('存在しないチームを更新しようとするとエラー', () => {
      registerParticipants(db, ['alice']);

      expect(() => {
        updateTeam(
          db,
          'default',
          { name: 'nonexistent', add: ['alice'] },
          'alice'
        );
      }).toThrow("チーム '@nonexistent' は存在しません");
    });

    it('未登録のメンバーを追加しようとするとエラー', () => {
      registerParticipants(db, ['alice', 'bob']);
      createTeam(
        db,
        'default',
        { name: 'team', members: ['bob'] },
        'alice'
      );

      expect(() => {
        updateTeam(
          db,
          'default',
          { name: 'team', add: ['unknown'] },
          'alice'
        );
      }).toThrow("参加者 '@unknown' は登録されていません");
    });
  });

  describe('deleteTeam - 正常系', () => {
    it('owner がチームを削除できる', () => {
      registerParticipants(db, ['alice', 'bob']);
      createTeam(
        db,
        'default',
        { name: 'team', members: ['bob'] },
        'alice'
      );

      const result = deleteTeam(db, 'default', 'team', 'alice');
      expect(result.deleted).toBe(true);

      // チームが削除されたことを確認
      const teams = getTeams(db, 'default');
      expect(teams).toHaveLength(0);

      // team_members も CASCADE で削除されることを確認
      const members = db
        .prepare('SELECT * FROM team_members WHERE tenant_id = ? AND team_name = ?')
        .all('default', '@team');
      expect(members).toHaveLength(0);
    });
  });

  describe('deleteTeam - 異常系', () => {
    it('owner 以外が削除しようとするとエラー', () => {
      registerParticipants(db, ['alice', 'bob']);
      createTeam(
        db,
        'default',
        { name: 'team', members: ['bob'] },
        'alice'
      );

      expect(() => {
        deleteTeam(db, 'default', 'team', 'bob');
      }).toThrow("チーム '@team' を削除できるのはオーナー '@alice' のみです");
    });

    it('存在しないチームを削除しようとするとエラー', () => {
      registerParticipants(db, ['alice']);

      expect(() => {
        deleteTeam(db, 'default', 'nonexistent', 'alice');
      }).toThrow("チーム '@nonexistent' は存在しません");
    });
  });

  describe('getTeams', () => {
    it('全チームを取得できる', () => {
      registerParticipants(db, ['alice', 'bob', 'charlie']);

      createTeam(db, 'default', { name: 'team1', members: [] }, 'alice');
      createTeam(db, 'default', { name: 'team2', members: [] }, 'bob');
      createTeam(db, 'default', { name: 'team3', members: [] }, 'charlie');

      const teams = getTeams(db, 'default');
      expect(teams).toHaveLength(3);
      expect(teams.map(t => t.name)).toContain('@team1');
      expect(teams.map(t => t.name)).toContain('@team2');
      expect(teams.map(t => t.name)).toContain('@team3');
    });

    it('チームが存在しない場合は空配列を返す', () => {
      const teams = getTeams(db, 'default');
      expect(teams).toEqual([]);
    });
  });

  describe('getTeamMembers', () => {
    it('チームのメンバー一覧を取得できる', () => {
      registerParticipants(db, ['alice', 'bob', 'charlie']);
      createTeam(
        db,
        'default',
        { name: 'team', members: ['bob', 'charlie'] },
        'alice'
      );

      const members = getTeamMembers(db, 'default', 'team');
      expect(members).toHaveLength(3);
      expect(members).toContain('@alice');
      expect(members).toContain('@bob');
      expect(members).toContain('@charlie');
    });

    it('メンバーが存在しない場合は空配列を返す', () => {
      const members = getTeamMembers(db, 'default', 'nonexistent');
      expect(members).toEqual([]);
    });

    // issue #15: soft-deleted participant が phantom member として残るのを防ぐ
    it('soft-deleted participant は phantom として返さない', () => {
      registerParticipants(db, ['alice', 'bob', 'charlie']);
      createTeam(
        db,
        'default',
        { name: 'team', members: ['bob', 'charlie'] },
        'alice'
      );

      // pre-condition: 3 名全員 (= alice / bob / charlie) が含まれる
      const beforeDelete = getTeamMembers(db, 'default', 'team');
      expect(beforeDelete).toHaveLength(3);
      expect(beforeDelete).toContain('@charlie');

      // bob を soft-delete (= participants.deleted_at = now)
      db.prepare(
        "UPDATE participants SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE tenant_id = ? AND name = ?"
      ).run('default', '@bob');

      // post-condition: bob は除外、 active member のみ返る
      const afterDelete = getTeamMembers(db, 'default', 'team');
      expect(afterDelete).toHaveLength(2);
      expect(afterDelete).toContain('@alice');
      expect(afterDelete).toContain('@charlie');
      expect(afterDelete).not.toContain('@bob');
    });

    // issue #15: 全 member が soft-deleted な team は空配列を返す
    it('全 member が soft-deleted な場合も空配列を返す (= phantom 完全除去)', () => {
      registerParticipants(db, ['alice', 'bob']);
      createTeam(
        db,
        'default',
        { name: 'team', members: ['bob'] },
        'alice'
      );

      // alice / bob 両方を soft-delete
      db.prepare(
        "UPDATE participants SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE tenant_id = ?"
      ).run('default');

      const members = getTeamMembers(db, 'default', 'team');
      expect(members).toEqual([]);
    });
  });

  describe('isTeamMember', () => {
    it('メンバーの場合は true を返す', () => {
      registerParticipants(db, ['alice', 'bob']);
      createTeam(
        db,
        'default',
        { name: 'team', members: ['bob'] },
        'alice'
      );

      expect(isTeamMember(db, 'default', 'team', 'alice')).toBe(true);
      expect(isTeamMember(db, 'default', 'team', 'bob')).toBe(true);
    });

    it('メンバーでない場合は false を返す', () => {
      registerParticipants(db, ['alice', 'bob', 'charlie']);
      createTeam(
        db,
        'default',
        { name: 'team', members: ['bob'] },
        'alice'
      );

      expect(isTeamMember(db, 'default', 'team', 'charlie')).toBe(false);
    });

    it('チームが存在しない場合は false を返す', () => {
      registerParticipants(db, ['alice']);
      expect(isTeamMember(db, 'default', 'nonexistent', 'alice')).toBe(false);
    });
  });

  describe('統合テスト: 作成→追加→削除→削除のフロー', () => {
    it('チームのライフサイクル全体が正常に動作する', () => {
      // 1. 参加者を登録
      registerParticipants(db, ['alice', 'bob', 'charlie', 'david']);

      // 2. チームを作成
      const team = createTeam(
        db,
        'default',
        { name: 'project', members: ['bob'] },
        'alice'
      );
      expect(team.name).toBe('@project');
      expect(getTeamMembers(db, 'default', 'project')).toHaveLength(2); // alice, bob

      // 3. メンバーを追加
      updateTeam(
        db,
        'default',
        { name: 'project', add: ['charlie', 'david'] },
        'alice'
      );
      expect(getTeamMembers(db, 'default', 'project')).toHaveLength(4);

      // 4. メンバーを削除
      updateTeam(
        db,
        'default',
        { name: 'project', remove: ['bob'] },
        'alice'
      );
      const members = getTeamMembers(db, 'default', 'project');
      expect(members).toHaveLength(3);
      expect(members).not.toContain('@bob');

      // 5. チームを削除
      deleteTeam(db, 'default', 'project', 'alice');
      expect(getTeams(db, 'default')).toHaveLength(0);
      expect(getTeamMembers(db, 'default', 'project')).toHaveLength(0);
    });
  });
});
