import { describe, it, expect, beforeEach } from 'vitest';
import { BoundedInMemoryEventStore } from '../event-store.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

function msg(n: number): JSONRPCMessage {
  return {
    jsonrpc: '2.0',
    method: 'notifications/resources/updated',
    params: { uri: `inbox://test-${n}` },
  };
}

/** `notifications/resources/updated` 以外のメッセージ (= replayFilter テスト用) */
function otherMsg(n: number): JSONRPCMessage {
  return {
    jsonrpc: '2.0',
    method: 'notifications/tools/list_changed',
    params: { seq: n },
  };
}

describe('BoundedInMemoryEventStore', () => {
  describe('basic store/replay', () => {
    let store: BoundedInMemoryEventStore;
    beforeEach(() => {
      store = new BoundedInMemoryEventStore();
    });

    it('stored event は getStreamIdForEventId で引ける', async () => {
      const id = await store.storeEvent('s1', msg(1));
      expect(await store.getStreamIdForEventId(id)).toBe('s1');
    });

    it('lastEventId 以降のみ replay する', async () => {
      const e1 = await store.storeEvent('s1', msg(1));
      const _e2 = await store.storeEvent('s1', msg(2));
      void _e2;
      const _e3 = await store.storeEvent('s1', msg(3));
      void _e3;
      const sent: Array<{ id: string; m: JSONRPCMessage }> = [];
      const streamId = await store.replayEventsAfter(e1, {
        send: async (id, m) => {
          sent.push({ id, m });
        },
      });
      expect(streamId).toBe('s1');
      expect(sent.map((s) => (s.m.params as { uri: string }).uri)).toEqual([
        'inbox://test-2',
        'inbox://test-3',
      ]);
    });

    it('別 stream の event は replay されない (tenant 分離維持)', async () => {
      const e1 = await store.storeEvent('s1', msg(1));
      await store.storeEvent('s2', msg(2));
      await store.storeEvent('s1', msg(3));
      const sent: string[] = [];
      await store.replayEventsAfter(e1, {
        send: async (_id, m) => {
          sent.push((m.params as { uri: string }).uri);
        },
      });
      expect(sent).toEqual(['inbox://test-3']);
    });

    it('未知の lastEventId なら空文字を返す (= NoOp)', async () => {
      const r = await store.replayEventsAfter('unknown_id', {
        send: async () => {},
      });
      expect(r).toBe('');
    });
  });

  describe('size bound', () => {
    it('maxEventsPerStream を超えると古いものから捨てる', async () => {
      const store = new BoundedInMemoryEventStore({ maxEventsPerStream: 3 });
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(await store.storeEvent('s1', msg(i)));
      }
      // 最初の 2 つは捨てられている
      expect(await store.getStreamIdForEventId(ids[0]!)).toBeUndefined();
      expect(await store.getStreamIdForEventId(ids[1]!)).toBeUndefined();
      expect(await store.getStreamIdForEventId(ids[2]!)).toBe('s1');
      expect(await store.getStreamIdForEventId(ids[4]!)).toBe('s1');
      expect(store.stats().totalEvents).toBe(3);
    });
  });

  describe('TTL', () => {
    it('TTL を超えた event は replay されない', async () => {
      let now = 1000;
      const store = new BoundedInMemoryEventStore({
        ttlMs: 100,
        now: () => now,
      });
      const e1 = await store.storeEvent('s1', msg(1)); // t=1000
      now = 1050;
      await store.storeEvent('s1', msg(2)); // t=1050
      now = 2000;
      await store.storeEvent('s1', msg(3)); // t=2000 (e1, e2 は TTL 超え)
      const sent: string[] = [];
      await store.replayEventsAfter(e1, {
        send: async (_id, m) => {
          sent.push((m.params as { uri: string }).uri);
        },
      });
      // e2 は TTL 超えで skip、e3 だけ送信
      expect(sent).toEqual(['inbox://test-3']);
    });

    it('storeEvent 時に TTL 切れの古い entries も整理される', async () => {
      let now = 1000;
      const store = new BoundedInMemoryEventStore({
        ttlMs: 100,
        now: () => now,
      });
      await store.storeEvent('s1', msg(1));
      await store.storeEvent('s1', msg(2));
      now = 2000;
      await store.storeEvent('s1', msg(3));
      // 古い 2 つは prune される
      expect(store.stats().totalEvents).toBe(1);
    });
  });

  describe('replayFilter (issue #117)', () => {
    /** `notifications/resources/updated` を replay しないフィルタ (= production 設定と同等) */
    const noResourceNotifyFilter = (m: JSONRPCMessage): boolean =>
      !('method' in m && m.method === 'notifications/resources/updated');

    it('filter が false を返した event は replay されない', async () => {
      const store = new BoundedInMemoryEventStore({ replayFilter: noResourceNotifyFilter });
      const e1 = await store.storeEvent('s1', msg(1));   // resource updated → filter=false
      await store.storeEvent('s1', otherMsg(2));          // other → filter=true
      await store.storeEvent('s1', msg(3));               // resource updated → filter=false

      const sent: string[] = [];
      await store.replayEventsAfter(e1, {
        send: async (_id, m) => { sent.push((m as { method: string }).method); },
      });
      // resource updated events are skipped; only otherMsg(2) replayed
      expect(sent).toEqual(['notifications/tools/list_changed']);
    });

    it('filter なしなら全 event が replay される (旧動作)', async () => {
      const store = new BoundedInMemoryEventStore(); // no filter
      const e1 = await store.storeEvent('s1', msg(1));
      await store.storeEvent('s1', otherMsg(2));
      await store.storeEvent('s1', msg(3));

      const sent: string[] = [];
      await store.replayEventsAfter(e1, {
        send: async (_id, m) => { sent.push((m as { method: string }).method); },
      });
      expect(sent).toEqual([
        'notifications/tools/list_changed',
        'notifications/resources/updated',
      ]);
    });

    it('filter で除外した event も storeEvent / getStreamIdForEventId では引ける (ID 連続性)', async () => {
      // event ID の連続性が崩れると Last-Event-ID ベースの resume が壊れる。
      // filter は replay 時のみ影響し、store / index は通常通り動くことを確認。
      const store = new BoundedInMemoryEventStore({ replayFilter: noResourceNotifyFilter });
      const e1 = await store.storeEvent('s1', msg(1));
      expect(await store.getStreamIdForEventId(e1)).toBe('s1');
      expect(store.stats().totalEvents).toBe(1);
    });

    it('全 event が filter=false なら replay は空になる', async () => {
      const store = new BoundedInMemoryEventStore({ replayFilter: noResourceNotifyFilter });
      const e1 = await store.storeEvent('s1', msg(1));
      await store.storeEvent('s1', msg(2));
      await store.storeEvent('s1', msg(3));

      const sent: JSONRPCMessage[] = [];
      await store.replayEventsAfter(e1, { send: async (_id, m) => { sent.push(m); } });
      expect(sent).toHaveLength(0);
    });
  });

  describe('event ordering', () => {
    it('replay は store された順 (= seq) で送信される', async () => {
      const store = new BoundedInMemoryEventStore();
      const e1 = await store.storeEvent('s1', msg(1));
      for (let i = 2; i <= 5; i++) await store.storeEvent('s1', msg(i));
      const seenOrder: string[] = [];
      await store.replayEventsAfter(e1, {
        send: async (_id, m) => {
          seenOrder.push((m.params as { uri: string }).uri);
        },
      });
      expect(seenOrder).toEqual([
        'inbox://test-2',
        'inbox://test-3',
        'inbox://test-4',
        'inbox://test-5',
      ]);
    });
  });
});
