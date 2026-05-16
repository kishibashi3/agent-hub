import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../../db/migrations.js';
import { scopeToTenant } from '../../../db/tenant-scope.js';
import { handleGetParticipants } from '../get_participants.js';
import { registerParticipant } from '../../../db/participants.js';
import { createTeam } from '../../../db/teams.js';

describe('get_participants ツール', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initDatabase(db);
  });

  it('参加者がいない場合は空配列を返す', async () => {
    const result = await handleGetParticipants(scopeToTenant(db, 'default'), {}, 'system');

    expect(result.isError).toBeUndefined();
    const entries = JSON.parse(result.content[0].text);
    expect(entries).toEqual([]);
  });

  it('複数の参加者を取得できる', async () => {
    // 直接 DB に登録（register ツールを経由しないテスト）
    registerParticipant(db, 'default', { name: 'alice' });
    registerParticipant(db, 'default', { name: 'bob', display_name: 'ボブ' });
    registerParticipant(db, 'default', { name: 'charlie' });

    const result = await handleGetParticipants(scopeToTenant(db, 'default'), {}, 'system');
    expect(result.isError).toBeUndefined();

    const entries = JSON.parse(result.content[0].text);
    const persons = entries.filter((e: any) => e.type === 'person');
    expect(persons).toHaveLength(3);

    // 作成日時の降順（最新が先）
    expect(persons[0].name).toBe('@charlie');
    expect(persons[1].name).toBe('@bob');
    expect(persons[1].display_name).toBe('ボブ');
    expect(persons[2].name).toBe('@alice');

    // 全員 type: person
    persons.forEach((p: any) => {
      expect(p.type).toBe('person');
    });
  });

  it('display_name が null の場合も正しく返す', async () => {
    registerParticipant(db, 'default', { name: 'alice' });

    const result = await handleGetParticipants(scopeToTenant(db, 'default'), {}, 'system');
    const entries = JSON.parse(result.content[0].text);
    const persons = entries.filter((e: any) => e.type === 'person');

    expect(persons[0].display_name).toBeNull();
  });

  it('isOnline コールバック未指定なら全員 is_online: false (後方互換)', async () => {
    // issue #1: 既存呼び出しコード (callback 渡さない) を壊さないこと。
    registerParticipant(db, 'default', { name: 'alice' });
    registerParticipant(db, 'default', { name: 'bob' });

    const result = await handleGetParticipants(scopeToTenant(db, 'default'), {}, 'system');
    const entries = JSON.parse(result.content[0].text);
    const persons = entries.filter((e: any) => e.type === 'person');

    expect(persons).toHaveLength(2);
    persons.forEach((p: any) => {
      expect(p.is_online).toBe(false);
    });
  });

  it('isOnline コールバックの結果が is_online フィールドに反映される', async () => {
    // issue #1: server.ts 側で sessions Map から組み立てた closure を渡される。
    registerParticipant(db, 'default', { name: 'alice' });
    registerParticipant(db, 'default', { name: 'bob' });
    registerParticipant(db, 'default', { name: 'charlie' });

    // @alice だけ online、他は offline と判定するモック
    const isOnline = (handle: string) => handle === '@alice';

    const result = await handleGetParticipants(
      scopeToTenant(db, 'default'),
      {},
      'system',
      isOnline
    );
    const entries = JSON.parse(result.content[0].text);

    const byName = Object.fromEntries(
      entries.filter((e: any) => e.type === 'person').map((p: any) => [p.name, p])
    );
    expect(byName['@alice'].is_online).toBe(true);
    expect(byName['@bob'].is_online).toBe(false);
    expect(byName['@charlie'].is_online).toBe(false);
  });

  describe('team metadata 統合 (issue: get_participants team info)', () => {
    it('team が 0 件のときは person のみを返す (team 関連 entry は出ない)', async () => {
      registerParticipant(db, 'default', { name: 'alice' });

      const result = await handleGetParticipants(scopeToTenant(db, 'default'), {}, 'system');
      const entries = JSON.parse(result.content[0].text);

      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('person');
      // person entry には team 専用 field が混入しないこと
      expect(entries[0]).not.toHaveProperty('owner');
      expect(entries[0]).not.toHaveProperty('members');
      expect(entries[0]).not.toHaveProperty('created_at');
    });

    it('team は name/type/owner/members/created_at を含む', async () => {
      registerParticipant(db, 'default', { name: 'alice' });
      registerParticipant(db, 'default', { name: 'bob' });
      registerParticipant(db, 'default', { name: 'charlie' });

      createTeam(
        db,
        'default',
        { name: 'team-alpha', members: ['bob', 'charlie'] },
        'alice'
      );

      const result = await handleGetParticipants(scopeToTenant(db, 'default'), {}, 'system');
      expect(result.isError).toBeUndefined();
      const entries = JSON.parse(result.content[0].text);

      const teams = entries.filter((e: any) => e.type === 'team');
      expect(teams).toHaveLength(1);

      const team = teams[0];
      expect(team.name).toBe('@team-alpha');
      expect(team.type).toBe('team');
      expect(team.owner).toBe('@alice');
      expect(team.members).toEqual(expect.arrayContaining(['@alice', '@bob', '@charlie']));
      expect(team.members).toHaveLength(3);
      expect(typeof team.created_at).toBe('string');
      expect(team.created_at.length).toBeGreaterThan(0);

      // team entry には person 専用 field が混入しないこと
      expect(team).not.toHaveProperty('display_name');
      expect(team).not.toHaveProperty('mode');
      expect(team).not.toHaveProperty('is_online');
    });

    it('person と team が混在する場合、person → team の順で返す', async () => {
      registerParticipant(db, 'default', { name: 'alice' });
      registerParticipant(db, 'default', { name: 'bob' });

      createTeam(db, 'default', { name: 'team-x', members: ['bob'] }, 'alice');

      const result = await handleGetParticipants(scopeToTenant(db, 'default'), {}, 'system');
      const entries = JSON.parse(result.content[0].text);

      expect(entries).toHaveLength(3); // person 2 + team 1
      // 先に person、後に team
      expect(entries[0].type).toBe('person');
      expect(entries[1].type).toBe('person');
      expect(entries[2].type).toBe('team');
      expect(entries[2].name).toBe('@team-x');
    });

    it('複数 team をそれぞれの members 込みで返せる', async () => {
      registerParticipant(db, 'default', { name: 'alice' });
      registerParticipant(db, 'default', { name: 'bob' });
      registerParticipant(db, 'default', { name: 'charlie' });

      createTeam(db, 'default', { name: 'team1', members: ['bob'] }, 'alice');
      createTeam(db, 'default', { name: 'team2', members: ['charlie'] }, 'bob');

      const result = await handleGetParticipants(scopeToTenant(db, 'default'), {}, 'system');
      const entries = JSON.parse(result.content[0].text);

      const teamsByName = Object.fromEntries(
        entries.filter((e: any) => e.type === 'team').map((t: any) => [t.name, t])
      );

      expect(teamsByName['@team1'].owner).toBe('@alice');
      expect(teamsByName['@team1'].members).toEqual(
        expect.arrayContaining(['@alice', '@bob'])
      );
      expect(teamsByName['@team1'].members).toHaveLength(2);

      expect(teamsByName['@team2'].owner).toBe('@bob');
      expect(teamsByName['@team2'].members).toEqual(
        expect.arrayContaining(['@bob', '@charlie'])
      );
      expect(teamsByName['@team2'].members).toHaveLength(2);
    });

    it('team は tenant 境界を超えない (別 tenant の team は見えない)', async () => {
      // tenant-a に team を作る
      db.prepare("INSERT INTO tenants (domain, owner) VALUES (?, ?)").run(
        'tenant-a',
        'alice'
      );
      registerParticipant(db, 'tenant-a', { name: 'alice' });
      createTeam(db, 'tenant-a', { name: 'secret', members: [] }, 'alice');

      // tenant-b からは見えてはいけない
      db.prepare("INSERT INTO tenants (domain, owner) VALUES (?, ?)").run(
        'tenant-b',
        'bob'
      );
      registerParticipant(db, 'tenant-b', { name: 'bob' });

      // (1) positive 側: tenant-a 自身からは @secret が 1 件見える
      //     (これがないと「team の作成自体が失敗していて、たまたま空配列が
      //     返って test が通る」誤検知を見落とす。reviewer suggestion #1)
      const insideResult = await handleGetParticipants(
        scopeToTenant(db, 'tenant-a'),
        {},
        'system'
      );
      const insideEntries = JSON.parse(insideResult.content[0].text);
      const insideTeams = insideEntries.filter((e: any) => e.type === 'team');
      expect(insideTeams).toHaveLength(1);
      expect(insideTeams[0].name).toBe('@secret');
      expect(insideTeams[0].owner).toBe('@alice');

      // (2) negative 側: tenant-b には person 1 件 (@bob) のみ、team は無い
      const result = await handleGetParticipants(scopeToTenant(db, 'tenant-b'), {}, 'system');
      const entries = JSON.parse(result.content[0].text);

      const persons = entries.filter((e: any) => e.type === 'person');
      const teams = entries.filter((e: any) => e.type === 'team');
      expect(persons.map((p: any) => p.name)).toEqual(['@bob']);
      expect(teams).toEqual([]);
    });
  });
});
