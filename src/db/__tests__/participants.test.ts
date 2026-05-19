import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  registerParticipant,
  getParticipants,
  getParticipantByName,
  findOtherTenantsForHandleAndOwner,
  softDeleteParticipant,
} from '../participants.js';
import { initDatabase } from '../migrations.js';

describe('participants', () => {
  let db: Database.Database;

  beforeEach(() => {
    // インメモリDBでテスト
    db = new Database(':memory:');
    initDatabase(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('registerParticipant', () => {
    it('正常系: 新規参加者を登録できる', () => {
      const input = {
        name: 'kishibashi',
        display_name: '岸橋',
      };

      const result = registerParticipant(db, 'default', input);

      expect(result.name).toBe('@kishibashi');
      expect(result.display_name).toBe('岸橋');
      expect(result.created_at).toBeTruthy();
    });

    it('正常系: display_name なしで登録できる', () => {
      const input = {
        name: 'agent-a',
      };

      const result = registerParticipant(db, 'default', input);

      expect(result.name).toBe('@agent-a');
      expect(result.display_name).toBeNull();
    });

    it('異常系: 同名の参加者は登録できない', () => {
      const input = { name: 'kishibashi' };

      registerParticipant(db, 'default', input);

      expect(() => {
        registerParticipant(db, 'default', input);
      }).toThrow('既に登録されています');
    });

    it('異常系: 名前が空文字列の場合エラー', () => {
      const input = { name: '' };

      expect(() => {
        registerParticipant(db, 'default', input);
      }).toThrow();
    });

    it('異常系: 名前に不正な文字が含まれる場合エラー', () => {
      const input = { name: 'invalid name' }; // スペース含む

      expect(() => {
        registerParticipant(db, 'default', input);
      }).toThrow();
    });

    it('異常系: 名前に @ が含まれる場合エラー', () => {
      const input = { name: '@kishibashi' }; // @ は付けない前提

      expect(() => {
        registerParticipant(db, 'default', input);
      }).toThrow();
    });
  });

  describe('getParticipants', () => {
    it('正常系: 全参加者を取得できる', () => {
      registerParticipant(db, 'default', { name: 'user1' });
      registerParticipant(db, 'default', { name: 'user2' });
      registerParticipant(db, 'default', { name: 'user3' });

      const results = getParticipants(db, 'default');

      expect(results).toHaveLength(3);
      expect(results[0].name).toBe('@user3'); // 降順
      expect(results[1].name).toBe('@user2');
      expect(results[2].name).toBe('@user1');
    });

    it('正常系: 参加者が0件の場合空配列を返す', () => {
      const results = getParticipants(db, 'default');

      expect(results).toEqual([]);
    });
  });

  describe('getParticipantByName', () => {
    beforeEach(() => {
      registerParticipant(db, 'default', {
        name: 'kishibashi',
        display_name: '岸橋',
      });
    });

    it('正常系: 存在する参加者を取得できる', () => {
      const result = getParticipantByName(db, 'default', '@kishibashi');

      expect(result).not.toBeNull();
      expect(result?.name).toBe('@kishibashi');
      expect(result?.display_name).toBe('岸橋');
    });

    it('正常系: 存在しない参加者は null を返す', () => {
      const result = getParticipantByName(db, 'default', '@nonexistent');

      expect(result).toBeNull();
    });

    it('正常系: @ なしで検索した場合は null を返す', () => {
      const result = getParticipantByName(db, 'default', 'kishibashi');

      expect(result).toBeNull();
    });
  });

  describe('統合テスト', () => {
    it('登録→取得→名前検索の一連の流れ', () => {
      // 1. 複数登録
      registerParticipant(db, 'default', { name: 'alice', display_name: 'アリス' });
      registerParticipant(db, 'default', { name: 'bob' });
      registerParticipant(db, 'default', { name: 'carol', display_name: 'キャロル' });

      // 2. 全取得
      const all = getParticipants(db, 'default');
      expect(all).toHaveLength(3);

      // 3. 名前検索
      const alice = getParticipantByName(db, 'default', '@alice');
      expect(alice?.display_name).toBe('アリス');

      const bob = getParticipantByName(db, 'default', '@bob');
      expect(bob?.display_name).toBeNull();

      const notFound = getParticipantByName(db, 'default', '@dave');
      expect(notFound).toBeNull();
    });
  });

  describe('findOtherTenantsForHandleAndOwner (issue #28)', () => {
    /** named tenant を pre-create する helper (= multi-tenant TOFU 経路を test 用に bypass) */
    function ensureTenant(domain: string, owner: string): void {
      db.prepare(
        `INSERT OR IGNORE INTO tenants (domain, owner) VALUES (?, ?)`
      ).run(domain, owner);
    }

    it('同 owner + 同 handle が他 tenant に存在する場合、 当該 tenant 一覧を返す', () => {
      // default で @bridge owned by alice
      registerParticipant(db, 'default', { name: 'bridge' }, 'alice');
      // tenant-a / tenant-b でも owner=alice で @bridge を登録
      ensureTenant('tenant-a', 'alice');
      ensureTenant('tenant-b', 'alice');
      registerParticipant(db, 'tenant-a', { name: 'bridge' }, 'alice');
      registerParticipant(db, 'tenant-b', { name: 'bridge' }, 'alice');

      const result = findOtherTenantsForHandleAndOwner(
        db,
        '@bridge',
        'alice',
        'default'
      );

      // tenant_id 昇順で 2 件
      expect(result).toEqual(['tenant-a', 'tenant-b']);
    });

    it('別 owner の同名 handle は match させない (= false positive 防止)', () => {
      registerParticipant(db, 'default', { name: 'bridge' }, 'alice');
      ensureTenant('tenant-a', 'bob');
      registerParticipant(db, 'tenant-a', { name: 'bridge' }, 'bob');

      // owner=alice で問い合わせ → bob 所有の @bridge は除外
      const result = findOtherTenantsForHandleAndOwner(
        db,
        '@bridge',
        'alice',
        'default'
      );
      expect(result).toEqual([]);
    });

    it('soft-deleted な row は除外', () => {
      registerParticipant(db, 'default', { name: 'bridge' }, 'alice');
      ensureTenant('tenant-a', 'alice');
      registerParticipant(db, 'tenant-a', { name: 'bridge' }, 'alice');

      // tenant-a 側の @bridge を soft delete
      softDeleteParticipant(db, 'tenant-a', '@bridge');

      const result = findOtherTenantsForHandleAndOwner(
        db,
        '@bridge',
        'alice',
        'default'
      );
      expect(result).toEqual([]);
    });

    it('excludeTenantId 自身は match に含めない', () => {
      ensureTenant('tenant-a', 'alice');
      registerParticipant(db, 'tenant-a', { name: 'bridge' }, 'alice');

      // tenant-a を exclude すれば、 他に登録ない場合は empty
      const result = findOtherTenantsForHandleAndOwner(
        db,
        '@bridge',
        'alice',
        'tenant-a'
      );
      expect(result).toEqual([]);
    });

    it('該当なしの場合は空配列', () => {
      registerParticipant(db, 'default', { name: 'lonely' }, 'alice');

      const result = findOtherTenantsForHandleAndOwner(
        db,
        '@lonely',
        'alice',
        'default'
      );
      expect(result).toEqual([]);
    });
  });
});
