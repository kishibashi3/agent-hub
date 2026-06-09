import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../../db/migrations.js';
import { scopeToTenant } from '../../../db/tenant-scope.js';
import { handleRegister } from '../register.js';
import {
  handleDeleteParticipant,
  handleGetParticipantHistory,
  handleListSessionsByParticipant,
  type SessionView,
} from '../admin.js';
import { handleSendMessage } from '../send_message.js';
import { handleCreateTeam } from '../create_team.js';

// ---- helpers for list_sessions_by_participant tests --------------------------------

function makeSession(overrides: Partial<SessionView> & { userId: string }): SessionView {
  return {
    tenantDomain: 'default',
    githubLogin: overrides.userId.replace('@', ''),
    subscribedUris: new Set(),
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeEntries(
  sessions: Array<[string, SessionView]>
): Iterable<readonly [string, SessionView]> {
  return sessions as Iterable<readonly [string, SessionView]>;
}

describe('admin ツール', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    initDatabase(db);
    // bootstrap: @admin と一般 peer を作る
    await handleRegister(scopeToTenant(db, 'default'), { name: 'admin' }, 'admin', 'kishibashi');
    await handleRegister(scopeToTenant(db, 'default'), { name: 'alice' }, 'alice', 'alice-gh');
    await handleRegister(scopeToTenant(db, 'default'), { name: 'bob' }, 'bob', 'bob-gh');
  });

  describe('権限チェック (共通)', () => {
    it('@admin 以外は delete_participant を呼べない', async () => {
      const r = await handleDeleteParticipant(scopeToTenant(db, 'default'), { name: 'alice' }, 'bob');
      expect(r.isError).toBe(true);
      const body = JSON.parse(r.content[0].text as string);
      expect(body.error).toBe('forbidden');
    });

    it('@admin 以外は get_participant_history を呼べない', async () => {
      const r = await handleGetParticipantHistory(scopeToTenant(db, 'default'), { name: 'alice' }, 'bob');
      expect(r.isError).toBe(true);
      const body = JSON.parse(r.content[0].text as string);
      expect(body.error).toBe('forbidden');
    });
  });

  describe('delete_participant', () => {
    it('admin として participant を soft delete できる', async () => {
      const r = await handleDeleteParticipant(scopeToTenant(db, 'default'), { name: 'alice' }, '@admin');
      expect(r.isError).toBeUndefined();
      const body = JSON.parse(r.content[0].text as string);
      expect(body.deleted).toBe('@alice');
      expect(body.mode).toBe('soft');

      // 行は残っているが deleted_at がセットされている
      const row = db
        .prepare(
          'SELECT name, deleted_at FROM participants WHERE tenant_id = ? AND name = ?'
        )
        .get('default', '@alice') as { name: string; deleted_at: string | null } | undefined;
      expect(row).toBeDefined();
      expect(row?.deleted_at).not.toBeNull();
    });

    it('@admin 自身は削除できない', async () => {
      const r = await handleDeleteParticipant(scopeToTenant(db, 'default'), { name: 'admin' }, '@admin');
      expect(r.isError).toBe(true);
      const body = JSON.parse(r.content[0].text as string);
      expect(body.message).toContain('@admin');
    });

    it('存在しない participant は削除できない', async () => {
      const r = await handleDeleteParticipant(scopeToTenant(db, 'default'), { name: 'ghost' }, '@admin');
      expect(r.isError).toBe(true);
      const body = JSON.parse(r.content[0].text as string);
      expect(body.message).toContain("'@ghost'");
    });

    it('チームを所有していても soft delete できる (FK 残存)', async () => {
      // alice が team を作成
      await handleCreateTeam(
        scopeToTenant(db, 'default'),
        { name: 'project-x', members: ['alice'] },
        'alice'
      );

      const r = await handleDeleteParticipant(scopeToTenant(db, 'default'), { name: 'alice' }, '@admin');
      expect(r.isError).toBeUndefined();

      // チーム自体は残る (FK 制約のため row は消えない、運用で別 admin が引き継ぐ前提)
      const team = db
        .prepare('SELECT name FROM teams WHERE tenant_id = ? AND name = ?')
        .get('default', '@project-x');
      expect(team).toBeDefined();
    });

    it('soft delete 後も送信済メッセージは残る (FK 整合)', async () => {
      // alice が bob にメッセージ送信
      await handleSendMessage(
        scopeToTenant(db, 'default'),
        { to: 'bob', message: 'hello bob' },
        'alice'
      );

      const r = await handleDeleteParticipant(scopeToTenant(db, 'default'), { name: 'alice' }, '@admin');
      expect(r.isError).toBeUndefined();

      // soft delete では messages は残る (audit のため)
      const afterMsgs = db
        .prepare('SELECT COUNT(*) as c FROM messages WHERE tenant_id = ? AND sender = ?')
        .get('default', '@alice') as { c: number };
      expect(afterMsgs.c).toBe(1);
    });

    it('name バリデーション: 空は拒否', async () => {
      const r = await handleDeleteParticipant(scopeToTenant(db, 'default'), { name: '' }, '@admin');
      expect(r.isError).toBe(true);
    });

    it('@ 付き / なし両方受け付ける', async () => {
      const r = await handleDeleteParticipant(scopeToTenant(db, 'default'), { name: '@bob' }, '@admin');
      expect(r.isError).toBeUndefined();
      const body = JSON.parse(r.content[0].text as string);
      expect(body.deleted).toBe('@bob');
    });
  });

  describe('get_participant_history', () => {
    beforeEach(async () => {
      // alice → bob, bob → alice の DM を仕込む
      await handleSendMessage(scopeToTenant(db, 'default'), { to: 'bob', message: 'hi bob' }, 'alice');
      await handleSendMessage(scopeToTenant(db, 'default'), { to: 'alice', message: 'hi alice' }, 'bob');
      await handleSendMessage(scopeToTenant(db, 'default'), { to: 'admin', message: 'cc admin' }, 'alice');
    });

    it('admin として participant の履歴 (sent + received) を取得できる', async () => {
      const r = await handleGetParticipantHistory(scopeToTenant(db, 'default'), { name: 'alice' }, '@admin');
      expect(r.isError).toBeUndefined();
      const body = JSON.parse(r.content[0].text as string);
      expect(body.user).toBe('@alice');
      // alice が sender か recipient のメッセージ全部 (3 件)
      expect(body.count).toBe(3);
    });

    it('limit を効かせられる', async () => {
      const r = await handleGetParticipantHistory(scopeToTenant(db, 'default'), { name: 'alice', limit: 1 }, '@admin');
      expect(r.isError).toBeUndefined();
      const body = JSON.parse(r.content[0].text as string);
      expect(body.count).toBe(1);
    });

    it('存在しない participant は拒否', async () => {
      const r = await handleGetParticipantHistory(scopeToTenant(db, 'default'), { name: 'ghost' }, '@admin');
      expect(r.isError).toBe(true);
    });

    it('limit > 500 は zod で拒否', async () => {
      const r = await handleGetParticipantHistory(scopeToTenant(db, 'default'), { name: 'alice', limit: 9999 }, '@admin');
      expect(r.isError).toBe(true);
    });
  });
});

// ============================================================
// list_sessions_by_participant (issue #115)
// ============================================================

describe('list_sessions_by_participant', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    initDatabase(db);
    await handleRegister(scopeToTenant(db, 'default'), { name: 'admin' }, 'admin', 'kishibashi');
    await handleRegister(scopeToTenant(db, 'default'), { name: 'alice' }, 'alice', 'alice-gh');
    await handleRegister(scopeToTenant(db, 'default'), { name: 'bob' }, 'bob', 'bob-gh');
  });

  afterEach(() => {
    db.close();
  });

  it('@admin 以外は forbidden', async () => {
    const entries = makeEntries([]);
    const r = await handleListSessionsByParticipant(
      scopeToTenant(db, 'default'), { name: 'alice' }, '@bob', entries
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text as string).error).toBe('forbidden');
  });

  it('セッションがない場合は空配列を返す', async () => {
    const entries = makeEntries([]);
    const r = await handleListSessionsByParticipant(
      scopeToTenant(db, 'default'), { name: 'alice' }, '@admin', entries
    );
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(r.content[0].text as string);
    expect(body.user).toBe('@alice');
    expect(body.count).toBe(0);
    expect(body.sessions).toEqual([]);
  });

  it('一致する session のみ返す (他 user は除外)', async () => {
    const aliceSid = 'sid-alice-1';
    const bobSid = 'sid-bob-1';
    const entries = makeEntries([
      [aliceSid, makeSession({ userId: '@alice', tenantDomain: 'default', githubLogin: 'alice-gh' })],
      [bobSid,   makeSession({ userId: '@bob',   tenantDomain: 'default', githubLogin: 'bob-gh'   })],
    ]);
    const r = await handleListSessionsByParticipant(
      scopeToTenant(db, 'default'), { name: 'alice' }, '@admin', entries
    );
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(r.content[0].text as string);
    expect(body.count).toBe(1);
    expect(body.sessions[0].session_id).toBe(aliceSid);
    expect(body.sessions[0].user).toBe('@alice');
    expect(body.sessions[0].tenant_id).toBe('default');
    expect(body.sessions[0].is_alive).toBe(true);
  });

  it('同 user の複数 session を全件返す (zombie 観測ユースケース)', async () => {
    const now = Date.now();
    const entries = makeEntries([
      ['sid-a1', makeSession({ userId: '@alice', createdAt: now - 2000 })],
      ['sid-a2', makeSession({ userId: '@alice', createdAt: now - 1000 })],
      ['sid-a3', makeSession({ userId: '@alice', createdAt: now })],
    ]);
    const r = await handleListSessionsByParticipant(
      scopeToTenant(db, 'default'), { name: 'alice' }, '@admin', entries
    );
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(r.content[0].text as string);
    expect(body.count).toBe(3);
    // created_at DESC ソート: 最新が先頭
    expect(body.sessions[0].session_id).toBe('sid-a3');
    expect(body.sessions[2].session_id).toBe('sid-a1');
  });

  it('tenant フィルタが効く', async () => {
    const entries = makeEntries([
      ['sid-default', makeSession({ userId: '@alice', tenantDomain: 'default' })],
      ['sid-other',   makeSession({ userId: '@alice', tenantDomain: 'other-tenant' })],
    ]);
    const r = await handleListSessionsByParticipant(
      scopeToTenant(db, 'default'),
      { name: 'alice', tenant: 'default' },
      '@admin',
      entries
    );
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(r.content[0].text as string);
    expect(body.count).toBe(1);
    expect(body.sessions[0].session_id).toBe('sid-default');
    expect(body.tenant).toBe('default');
  });

  it('tenant = null (省略) で全 tenant を横断返す', async () => {
    const entries = makeEntries([
      ['sid-default', makeSession({ userId: '@alice', tenantDomain: 'default' })],
      ['sid-other',   makeSession({ userId: '@alice', tenantDomain: 'other-tenant' })],
    ]);
    const r = await handleListSessionsByParticipant(
      scopeToTenant(db, 'default'),
      { name: 'alice' }, // tenant 省略 = null
      '@admin',
      entries
    );
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(r.content[0].text as string);
    expect(body.count).toBe(2);
    expect(body.tenant).toBeNull();
  });

  it('@ あり/なし両方の name を受け付ける', async () => {
    const entries = makeEntries([
      ['sid-a', makeSession({ userId: '@alice' })],
    ]);
    const withAt    = await handleListSessionsByParticipant(
      scopeToTenant(db, 'default'), { name: '@alice' }, '@admin', entries
    );
    const withoutAt = await handleListSessionsByParticipant(
      scopeToTenant(db, 'default'), { name: 'alice' },  '@admin', entries
    );
    expect(JSON.parse(withAt.content[0].text as string).count).toBe(1);
    expect(JSON.parse(withoutAt.content[0].text as string).count).toBe(1);
  });

  it('出力 shape が仕様通り (session_id / tenant_id / user / github_login / created_at / last_active_at / subscribed_uris / is_alive)', async () => {
    const createdAt = Date.now() - 5000;
    const uris = new Set(['inbox://alice']);
    const entries = makeEntries([
      ['sid-shape', makeSession({
        userId: '@alice',
        tenantDomain: 'default',
        githubLogin: 'alice-gh',
        createdAt,
        subscribedUris: uris,
      })],
    ]);
    const r = await handleListSessionsByParticipant(
      scopeToTenant(db, 'default'), { name: 'alice' }, '@admin', entries
    );
    expect(r.isError).toBeUndefined();
    const s = JSON.parse(r.content[0].text as string).sessions[0];
    expect(s.session_id).toBe('sid-shape');
    expect(s.tenant_id).toBe('default');
    expect(s.user).toBe('@alice');
    expect(s.github_login).toBe('alice-gh');
    expect(s.created_at).toBe(new Date(createdAt).toISOString());
    expect(s.subscribed_uris).toEqual(['inbox://alice']);
    expect(s.is_alive).toBe(true);
    // last_active_at: register 時に updateLastActiveAt が呼ばれるため non-null
    expect(typeof s.last_active_at).toBe('string');
  });

  it('last_active_at が participants に記録されていれば返す', async () => {
    // alice に send_message させて last_active_at を更新する
    await handleSendMessage(
      scopeToTenant(db, 'default'), { to: 'bob', message: 'hi' }, '@alice'
    );
    const entries = makeEntries([
      ['sid-a', makeSession({ userId: '@alice', tenantDomain: 'default' })],
    ]);
    const r = await handleListSessionsByParticipant(
      scopeToTenant(db, 'default'), { name: 'alice' }, '@admin', entries
    );
    const s = JSON.parse(r.content[0].text as string).sessions[0];
    expect(s.last_active_at).not.toBeNull();
  });

  it('name 空文字は zod でエラー', async () => {
    const r = await handleListSessionsByParticipant(
      scopeToTenant(db, 'default'), { name: '' }, '@admin', makeEntries([])
    );
    expect(r.isError).toBe(true);
  });
});
