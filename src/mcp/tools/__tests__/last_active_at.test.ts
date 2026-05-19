import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../../db/migrations.js';
import { scopeToTenant } from '../../../db/tenant-scope.js';
import { handleSendMessage } from '../send_message.js';
import { handleGetMessages } from '../get_messages.js';
import { handleMarkAsRead } from '../mark_as_read.js';
import { handleGetHistory } from '../get_history.js';
import { handleGetParticipants } from '../get_participants.js';
import { handleRegister } from '../register.js';
import { registerParticipant } from '../../../db/participants.js';

/**
 * issue #26 - last_active_at field の productive activity update を verify する。
 *
 * 設計 spec: `docs/design-last-active-at.md`
 *
 * - 更新する tool: send_message / get_messages / mark_as_read / register / get_history
 * - 更新しない: get_participants (= 観察行為)
 * - tenant 境界 + multi-peer 独立性 + soft-deleted re-activity も verify
 */
describe('last_active_at (issue #26)', () => {
  let db: Database.Database;

  /** participants table から特定 handle の last_active_at を直接 read する helper */
  function readLastActiveAt(
    tenantId: string,
    name: string
  ): string | null {
    const row = db
      .prepare(
        `SELECT last_active_at FROM participants WHERE tenant_id = ? AND name = ?`
      )
      .get(tenantId, name) as { last_active_at: string | null } | undefined;
    return row ? row.last_active_at : null;
  }

  /** 短い sleep (= timestamp の差分を保証するため。 strftime ms 精度) */
  async function tick(ms = 10): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
  }

  beforeEach(() => {
    db = new Database(':memory:');
    initDatabase(db);
    // 共通 participants 用意
    registerParticipant(db, 'default', { name: 'alice' });
    registerParticipant(db, 'default', { name: 'bob' });
  });

  describe('update する tool (= productive activity)', () => {
    it('send_message 呼出後、 sender の last_active_at が NULL → ISO timestamp に update される', async () => {
      expect(readLastActiveAt('default', '@alice')).toBeNull();

      const result = await handleSendMessage(
        scopeToTenant(db, 'default'),
        { to: '@bob', message: 'hi' },
        '@alice'
      );
      expect(result.isError).toBeUndefined();

      const after = readLastActiveAt('default', '@alice');
      expect(after).not.toBeNull();
      // strftime('%Y-%m-%d %H:%M:%f', 'now') 出力 (= YYYY-MM-DD HH:MM:SS.mmm)
      expect(after).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
    });

    it('get_messages 呼出後、 caller の last_active_at が update される (= empty fetch 含む)', async () => {
      // empty inbox でも update する (= polling-style active check)
      expect(readLastActiveAt('default', '@bob')).toBeNull();

      const result = await handleGetMessages(
        scopeToTenant(db, 'default'),
        {},
        '@bob'
      );
      expect(result.isError).toBeUndefined();

      expect(readLastActiveAt('default', '@bob')).not.toBeNull();
    });

    it('mark_as_read 呼出後、 reader の last_active_at が update される', async () => {
      // bob 宛 message を 1 通用意
      const sendResult = await handleSendMessage(
        scopeToTenant(db, 'default'),
        { to: '@bob', message: 'm1' },
        '@alice'
      );
      const msgId = JSON.parse(sendResult.content[0].text).id;

      // alice の last_active_at は send で update 済、 bob はまだ NULL
      const aliceBeforeMark = readLastActiveAt('default', '@alice');
      expect(aliceBeforeMark).not.toBeNull();
      expect(readLastActiveAt('default', '@bob')).toBeNull();

      await tick();
      const result = await handleMarkAsRead(
        scopeToTenant(db, 'default'),
        { message_id: msgId },
        '@bob'
      );
      expect(result.isError).toBeUndefined();

      expect(readLastActiveAt('default', '@bob')).not.toBeNull();
    });

    it('register 呼出後、 caller の last_active_at が update される (= spawn / re-register signal)', async () => {
      // 新規 (= 自分の handle で新規 register)
      const newResult = await handleRegister(
        scopeToTenant(db, 'default'),
        { name: 'newbie' },
        'system',
        'ishibashi-kazuhiro'
      );
      // bootstrap gate 影響回避のため @admin を先に登録
      // (= beforeEach で alice/bob 登録済 + adminExists 判定は @admin だが、
      //  bootstrap gate は `existing` がいる場合は通る。 ここでは @newbie が
      //  既存じゃないので gate が干渉する。 adminExists check で admin が
      //  存在しない & name !== admin の場合 reject される)
      // → so the above will reject. Test instead the re-register update path.
      void newResult; // 未使用宣言、 lint 回避

      // 既存 participant を re-register: alice が github login ishibashi で claim
      const result = await handleRegister(
        scopeToTenant(db, 'default'),
        { name: 'alice', display_name: 'Alice Re-Reg' },
        '@alice',
        'ishibashi-kazuhiro'
      );
      expect(result.isError).toBeUndefined();

      expect(readLastActiveAt('default', '@alice')).not.toBeNull();
    });

    it('get_history 呼出後、 caller の last_active_at が update される', async () => {
      // alice ↔ bob の history を 1 件用意
      await handleSendMessage(
        scopeToTenant(db, 'default'),
        { to: '@bob', message: 'h1' },
        '@alice'
      );
      // bob はまだ history を呼んでないので NULL
      expect(readLastActiveAt('default', '@bob')).toBeNull();

      const result = await handleGetHistory(
        scopeToTenant(db, 'default'),
        { to: '@alice' },
        '@bob'
      );
      // get_history は error 時も isError 立てない仕様 (旧コード)、 text JSON で error 判定
      const body = JSON.parse(result.content[0].text);
      expect(body.error).toBeUndefined();

      expect(readLastActiveAt('default', '@bob')).not.toBeNull();
    });
  });

  describe('update しない tool (= 観察行為)', () => {
    it('get_participants 呼出は caller の last_active_at を update しない', async () => {
      // alice の last_active_at は NULL のまま
      expect(readLastActiveAt('default', '@alice')).toBeNull();

      const result = await handleGetParticipants(
        scopeToTenant(db, 'default'),
        {},
        '@alice'
      );
      expect(result.isError).toBeUndefined();

      // 観察行為では NULL のまま
      expect(readLastActiveAt('default', '@alice')).toBeNull();
    });
  });

  describe('get_participants 返却に last_active_at field が含まれる', () => {
    it('未活動 participant は last_active_at: null で返却される (= backward compat)', async () => {
      const result = await handleGetParticipants(
        scopeToTenant(db, 'default'),
        {},
        'system'
      );
      const entries = JSON.parse(result.content[0].text);
      const persons = entries.filter((e: { type: string }) => e.type === 'person');

      for (const p of persons) {
        expect(p).toHaveProperty('last_active_at');
        expect(p.last_active_at).toBeNull();
      }
    });

    it('active participant は last_active_at: ISO timestamp で返却される', async () => {
      // alice が send_message → last_active_at set される
      await handleSendMessage(
        scopeToTenant(db, 'default'),
        { to: '@bob', message: 'hi' },
        '@alice'
      );

      const result = await handleGetParticipants(
        scopeToTenant(db, 'default'),
        {},
        'system'
      );
      const entries = JSON.parse(result.content[0].text);
      const byName = Object.fromEntries(
        entries
          .filter((e: { type: string }) => e.type === 'person')
          .map((p: { name: string }) => [p.name, p])
      );

      expect(byName['@alice'].last_active_at).toMatch(
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/
      );
      expect(byName['@bob'].last_active_at).toBeNull();
    });
  });

  describe('multi-peer 独立性', () => {
    it('2 peer が同時 active な場合、 互いの last_active_at は独立 update される', async () => {
      await handleSendMessage(
        scopeToTenant(db, 'default'),
        { to: '@bob', message: 'first' },
        '@alice'
      );
      const aliceFirst = readLastActiveAt('default', '@alice');
      expect(aliceFirst).not.toBeNull();
      // bob は何もしてないので NULL のまま
      expect(readLastActiveAt('default', '@bob')).toBeNull();

      await tick();
      await handleGetMessages(scopeToTenant(db, 'default'), {}, '@bob');
      const bobFirst = readLastActiveAt('default', '@bob');
      expect(bobFirst).not.toBeNull();
      // alice の値は bob の activity で変化していない
      expect(readLastActiveAt('default', '@alice')).toBe(aliceFirst);

      // 再度 alice が active → alice だけ更新、 bob は据え置き
      await tick();
      await handleSendMessage(
        scopeToTenant(db, 'default'),
        { to: '@bob', message: 'second' },
        '@alice'
      );
      const aliceSecond = readLastActiveAt('default', '@alice');
      expect(aliceSecond).not.toBeNull();
      expect(aliceSecond! > aliceFirst!).toBe(true);
      // bob は alice の send で変化しない
      expect(readLastActiveAt('default', '@bob')).toBe(bobFirst);
    });
  });

  describe('tenant 境界', () => {
    it('tenant A の @alice が active でも、 tenant B の @alice は update されない', async () => {
      // tenant-b を pre-create
      db.prepare("INSERT INTO tenants (domain, owner) VALUES (?, ?)").run(
        'tenant-b',
        'someone'
      );
      registerParticipant(db, 'tenant-b', { name: 'alice' });
      registerParticipant(db, 'tenant-b', { name: 'eve' });

      // tenant-default の alice → bob に send (= default tenant 内 only)
      await handleSendMessage(
        scopeToTenant(db, 'default'),
        { to: '@bob', message: 'cross-tenant test' },
        '@alice'
      );

      expect(readLastActiveAt('default', '@alice')).not.toBeNull();
      // tenant-b の同名 alice は影響を受けない
      expect(readLastActiveAt('tenant-b', '@alice')).toBeNull();
    });
  });

  describe('edge case', () => {
    it('soft-deleted participant に対する update も skip されない (= 削除後 re-activity も記録)', async () => {
      // alice を soft delete
      db.prepare(
        `UPDATE participants
           SET deleted_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
           WHERE tenant_id = ? AND name = ?`
      ).run('default', '@alice');

      // updateLastActiveAt は deleted_at に関係なく UPDATE できる
      scopeToTenant(db, 'default').updateLastActiveAt('@alice');

      // 直接 select で確認 (= getParticipantByName は deleted を除外するので使えない)
      const row = db
        .prepare(
          `SELECT last_active_at, deleted_at FROM participants
             WHERE tenant_id = ? AND name = ?`
        )
        .get('default', '@alice') as {
        last_active_at: string | null;
        deleted_at: string | null;
      };
      expect(row.last_active_at).not.toBeNull();
      expect(row.deleted_at).not.toBeNull();
    });

    it('連続 update で timestamp が monotonic に進む (= strftime ms 精度)', async () => {
      await handleSendMessage(
        scopeToTenant(db, 'default'),
        { to: '@bob', message: 'one' },
        '@alice'
      );
      const t1 = readLastActiveAt('default', '@alice');
      expect(t1).not.toBeNull();

      await tick();
      await handleSendMessage(
        scopeToTenant(db, 'default'),
        { to: '@bob', message: 'two' },
        '@alice'
      );
      const t2 = readLastActiveAt('default', '@alice');
      expect(t2).not.toBeNull();
      expect(t2! > t1!).toBe(true);
    });
  });
});
