import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../../db/migrations.js';
import { scopeToTenant } from '../../../db/tenant-scope.js';
import { registerParticipant } from '../../../db/participants.js';
import { sendMessage, markAsRead } from '../../../db/messages.js';
import {
  handleGetMessages,
  getMessagesTool,
  getGetMessagesMaxBytes,
  getGetMessagesDefaultLimit,
  encodeCursor,
  decodeCursor,
  GET_MESSAGES_MAX_BYTES,
} from '../get_messages.js';

/**
 * get_messages の paging / byte budget (issue #388)。
 *
 * 本 test の関心は「未読を無制限に 1 レスポンスで返さないこと」と
 * 「打ち切りを無言でやらないこと」の 2 点。
 */
describe('get_messages paging (issue #388)', () => {
  let db: Database.Database;

  const ENV_KEYS = [
    'AGENT_HUB_MCP_GET_MESSAGES_MAX_BYTES',
    'AGENT_HUB_MCP_GET_MESSAGES_DEFAULT_LIMIT',
  ] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];

    db = new Database(':memory:');
    initDatabase(db);
    registerParticipant(db, 'default', { name: 'alice' });
    registerParticipant(db, 'default', { name: 'bob' });
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    db.close();
    vi.restoreAllMocks();
  });

  /** alice → bob に n 件送る。body は連番入り */
  function seed(n: number, body: (i: number) => string = (i) => `msg-${i}`) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      ids.push(
        sendMessage(db, 'default', { to: 'bob', message: body(i) }, 'alice').id
      );
    }
    return ids;
  }

  function call(args: unknown) {
    const result = handleGetMessages(scopeToTenant(db, 'default'), args, '@bob');
    return {
      result,
      payload: JSON.parse(result.content[0].text as string),
    };
  }

  describe('後方互換 (引数なし呼び出し)', () => {
    it('limit も cursor も無い呼び出しは素の JSON 配列を返す', () => {
      seed(3);
      const { result, payload } = call({});

      expect(result.isError).toBeUndefined();
      expect(Array.isArray(payload)).toBe(true);
      expect(payload).toHaveLength(3);
      expect(payload[0].message).toBe('msg-0');
    });

    it('引数なしでは byte budget を超えても打ち切らず、WARN を 1 行出す', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      process.env.AGENT_HUB_MCP_GET_MESSAGES_MAX_BYTES = '1024';

      seed(20, () => 'x'.repeat(200));
      const { payload } = call({});

      // 打ち切らない (= 挙動不変)
      expect(payload).toHaveLength(20);
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = warn.mock.calls[0][0] as string;
      expect(logged).toContain('participant=@bob');
      expect(logged).toContain('unread_count=20');
      expect(logged).toContain('budget=1024');
    });

    it('budget 以内なら WARN は出ない', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      seed(2);
      call({});
      expect(warn).not.toHaveBeenCalled();
    });

    it('pretty-print を廃止しても既存 client の parse 結果は変わらない', () => {
      seed(1);
      const { result, payload } = call({});
      expect(result.content[0].text).not.toContain('\n');
      expect(payload[0].from).toBe('@alice');
    });
  });

  describe('envelope (limit / cursor 指定時)', () => {
    it('limit を指定すると envelope で返り、残件が判る', () => {
      seed(5);
      const { payload } = call({ limit: 2 });

      expect(payload.messages).toHaveLength(2);
      expect(payload.returned).toBe(2);
      expect(payload.has_more).toBe(true);
      expect(payload.remaining).toBe(3);
      expect(typeof payload.next_cursor).toBe('string');
      expect(payload.messages[0].message).toBe('msg-0');
      expect(payload.messages[1].message).toBe('msg-1');
    });

    it('next_cursor を辿ると重複・取りこぼしなく全件取得できる', () => {
      seed(7);

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const args: Record<string, unknown> = { limit: 3 };
        if (cursor) args.cursor = cursor;
        const { payload } = call(args);
        seen.push(...payload.messages.map((m: { message: string }) => m.message));
        cursor = payload.next_cursor;
        if (!payload.has_more) break;
      }

      expect(seen).toEqual([
        'msg-0',
        'msg-1',
        'msg-2',
        'msg-3',
        'msg-4',
        'msg-5',
        'msg-6',
      ]);
      expect(new Set(seen).size).toBe(7);
    });

    it('最終ページでは has_more=false / next_cursor=null', () => {
      seed(2);
      const { payload } = call({ limit: 5 });
      expect(payload.returned).toBe(2);
      expect(payload.has_more).toBe(false);
      expect(payload.remaining).toBe(0);
      expect(payload.next_cursor).toBeNull();
    });

    it('未読ゼロでも envelope の形は崩れない', () => {
      const { payload } = call({ limit: 5 });
      expect(payload.messages).toEqual([]);
      expect(payload.returned).toBe(0);
      expect(payload.has_more).toBe(false);
      expect(payload.remaining).toBe(0);
      expect(payload.next_cursor).toBeNull();
    });

    it('created_at が同値でも rowid の tie-break で挿入順が保たれる', () => {
      const ids = seed(5);
      // 全件の created_at を同一値に潰す (keyset の tie-break を強制的に踏ませる)
      db.prepare('UPDATE messages SET created_at = ? WHERE tenant_id = ?').run(
        '2026-09-20T00:00:00.000Z',
        'default'
      );

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const args: Record<string, unknown> = { limit: 2 };
        if (cursor) args.cursor = cursor;
        const { payload } = call(args);
        seen.push(...payload.messages.map((m: { id: string }) => m.id));
        cursor = payload.next_cursor;
        if (!payload.has_more) break;
      }

      // 取りこぼし・重複がないだけでなく、挿入順そのものが保たれる
      expect(seen).toEqual(ids);
    });
  });

  describe('ack-as-cursor (主動線)', () => {
    it('mark_as_read すれば cursor なしでも次のページに前進する', () => {
      seed(5);

      const first = call({ limit: 2 }).payload;
      expect(first.messages.map((m: { message: string }) => m.message)).toEqual([
        'msg-0',
        'msg-1',
      ]);
      for (const m of first.messages) markAsRead(db, 'default', m.id, '@bob');

      const second = call({ limit: 2 }).payload;
      expect(second.messages.map((m: { message: string }) => m.message)).toEqual([
        'msg-2',
        'msg-3',
      ]);
      expect(second.remaining).toBe(1);
    });
  });

  describe('byte budget', () => {
    it('limit より先に byte budget が当たると件数が絞られる', () => {
      process.env.AGENT_HUB_MCP_GET_MESSAGES_MAX_BYTES = '1024';
      seed(20, () => 'x'.repeat(200));

      const { payload } = call({ limit: 20 });

      expect(payload.returned).toBeGreaterThan(0);
      expect(payload.returned).toBeLessThan(20);
      expect(payload.has_more).toBe(true);
      expect(payload.remaining).toBe(20 - payload.returned);

      const bytes = Buffer.byteLength(
        JSON.stringify(payload.messages),
        'utf8'
      );
      expect(bytes).toBeLessThanOrEqual(1024);
    });

    it('1 件だけで budget を超える場合は body を切り詰めて必ず 1 件返す', () => {
      process.env.AGENT_HUB_MCP_GET_MESSAGES_MAX_BYTES = '1024';
      const huge = 'y'.repeat(5000);
      seed(1, () => huge);

      const { payload } = call({ limit: 10 });

      expect(payload.returned).toBe(1);
      const item = payload.messages[0];
      expect(item.truncated).toBe(true);
      expect(item.body_bytes).toBe(Buffer.byteLength(huge, 'utf8'));
      expect(item.message.length).toBeGreaterThan(0);
      expect(item.message.length).toBeLessThan(huge.length);
      expect(huge.startsWith(item.message)).toBe(true);

      const bytes = Buffer.byteLength(
        JSON.stringify(payload.messages),
        'utf8'
      );
      expect(bytes).toBeLessThanOrEqual(1024);
    });

    it('マルチバイト本文を切り詰めてもサロゲートペアや UTF-8 を割らない', () => {
      process.env.AGENT_HUB_MCP_GET_MESSAGES_MAX_BYTES = '1024';
      const huge = '🌀あ'.repeat(1000);
      seed(1, () => huge);

      const { payload } = call({ limit: 10 });
      const item = payload.messages[0];

      expect(item.truncated).toBe(true);
      expect(item.message).not.toContain('�');
      expect(huge.startsWith(item.message)).toBe(true);
      expect(
        Buffer.byteLength(JSON.stringify(payload.messages), 'utf8')
      ).toBeLessThanOrEqual(1024);
    });

    it('切り詰めても残件は has_more / remaining で判る', () => {
      process.env.AGENT_HUB_MCP_GET_MESSAGES_MAX_BYTES = '1024';
      seed(3, () => 'z'.repeat(5000));

      const { payload } = call({ limit: 10 });
      expect(payload.returned).toBe(1);
      expect(payload.has_more).toBe(true);
      expect(payload.remaining).toBe(2);
      expect(payload.next_cursor).not.toBeNull();
    });
  });

  describe('cursor の符号化', () => {
    it('encode → decode で往復する', () => {
      const cursor = { createdAt: '2026-09-20T00:00:00.000Z', rowId: 42 };
      expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    });

    it('rowid 部が整数でない cursor はエラーになる', () => {
      const bogus = Buffer.from('2026-09-20T00:00:00.000Z|abc', 'utf8').toString(
        'base64url'
      );
      expect(() => decodeCursor(bogus)).toThrow(/cursor/);
    });

    it('不正な cursor は無言で先頭に戻さずエラーにする', () => {
      seed(3);
      const { result, payload } = call({ cursor: 'not-a-cursor' });
      expect(result.isError).toBe(true);
      expect(payload.error).toBe('get_messages failed');
      expect(payload.message).toContain('cursor');
    });

    it('空文字 cursor はエラーになる', () => {
      const { result } = call({ cursor: '' });
      expect(result.isError).toBe(true);
    });
  });

  describe('引数の検証', () => {
    it.each([0, -1, 1001, 1.5, '10', null])(
      'limit=%s は妥当でなければエラーになる',
      (value) => {
        seed(1);
        const result = handleGetMessages(
          scopeToTenant(db, 'default'),
          { limit: value },
          '@bob'
        );
        if (value === null) {
          // null = 未指定扱い (= 配列で返る)
          expect(result.isError).toBeUndefined();
          return;
        }
        expect(result.isError).toBe(true);
      }
    );
  });

  describe('env flag', () => {
    it('既定値は 64 KiB / default limit は未設定 (= 上限なし)', () => {
      expect(getGetMessagesMaxBytes()).toBe(GET_MESSAGES_MAX_BYTES);
      expect(GET_MESSAGES_MAX_BYTES).toBe(65_536);
      expect(getGetMessagesDefaultLimit()).toBeNull();
    });

    it('AGENT_HUB_MCP_GET_MESSAGES_MAX_BYTES で上書きできる', () => {
      process.env.AGENT_HUB_MCP_GET_MESSAGES_MAX_BYTES = '4096';
      expect(getGetMessagesMaxBytes()).toBe(4096);
    });

    it.each(['0', '100', 'abc', '99999999999'])(
      '不正値 %s は既定値に fall back せず throw する (issue #384 と同方針)',
      (raw) => {
        process.env.AGENT_HUB_MCP_GET_MESSAGES_MAX_BYTES = raw;
        expect(() => getGetMessagesMaxBytes()).toThrow(/invalid/);
      }
    );

    it('DEFAULT_LIMIT を設定すると引数なし呼び出しも envelope になる (Phase 3)', () => {
      process.env.AGENT_HUB_MCP_GET_MESSAGES_DEFAULT_LIMIT = '2';
      seed(5);

      const { payload } = call({});
      expect(Array.isArray(payload)).toBe(false);
      expect(payload.returned).toBe(2);
      expect(payload.has_more).toBe(true);
      expect(payload.remaining).toBe(3);
    });

    it('DEFAULT_LIMIT を unset に戻せば即座に現行挙動へロールバックできる', () => {
      process.env.AGENT_HUB_MCP_GET_MESSAGES_DEFAULT_LIMIT = '2';
      seed(5);
      expect(Array.isArray(call({}).payload)).toBe(false);

      delete process.env.AGENT_HUB_MCP_GET_MESSAGES_DEFAULT_LIMIT;
      expect(Array.isArray(call({}).payload)).toBe(true);
      expect(call({}).payload).toHaveLength(5);
    });

    it.each(['0', '1001', 'abc'])(
      'DEFAULT_LIMIT の不正値 %s は throw する',
      (raw) => {
        process.env.AGENT_HUB_MCP_GET_MESSAGES_DEFAULT_LIMIT = raw;
        expect(() => getGetMessagesDefaultLimit()).toThrow(/invalid/);
      }
    );
  });

  describe('tool schema', () => {
    it('limit / cursor が inputSchema に露出している', () => {
      const props = getMessagesTool.inputSchema.properties as Record<
        string,
        unknown
      >;
      expect(props.limit).toBeDefined();
      expect(props.cursor).toBeDefined();
      expect(getMessagesTool.inputSchema.required).toEqual([]);
    });

    it('description が has_more / limit の意味に触れている', () => {
      expect(getMessagesTool.description).toContain('has_more');
      expect(getMessagesTool.description).toContain('limit');
      expect(getMessagesTool.description).toContain('mark_as_read');
    });
  });
});
