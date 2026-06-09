/**
 * Bounded in-memory EventStore for MCP Streamable HTTP transport resumability.
 *
 * Why this exists:
 *   StreamableHTTPServerTransport requires an EventStore for SSE notification
 *   resumability. Without it, notifications delivered while the GET stream is
 *   disconnected are silently dropped, and reconnecting clients cannot replay
 *   them via the standard `Last-Event-ID` header. The SDK ships an
 *   InMemoryEventStore example but it grows without bound. This implementation
 *   keeps the same semantics but bounds memory by:
 *     - per-stream max event count (default 200)
 *     - per-event TTL (default 10 min)
 *
 * Single process-wide instance is intended (`storeEvent` separates by streamId).
 *
 * Reference: src/mcp/__tests__/event_store.test.ts for behavior contract,
 * agent-hub#7 follow-up (SSE 切断後の resumability) for design context.
 */

import type {
  EventStore,
  EventId,
  StreamId,
} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

interface StoredEvent {
  eventId: EventId;
  streamId: StreamId;
  message: JSONRPCMessage;
  storedAt: number; // epoch ms
}

export interface BoundedInMemoryEventStoreOptions {
  /** stream あたり保持する最大 event 数。古いものから順に捨てる */
  maxEventsPerStream?: number;
  /** event の TTL (ms)。これより古い event は replay 時に skip */
  ttlMs?: number;
  /** clock injection (test 用) */
  now?: () => number;
  /**
   * replay 時の event フィルタ (= issue #117 fix)。
   *
   * `replayEventsAfter` で各 event を送信する前に呼び出し、`false` を返した
   * event は replay から除外する。`undefined` なら全 event を replay (= 旧動作)。
   *
   * 主用途: `notifications/resources/updated` (= inbox hint) の replay 抑制。
   * これらは「新着あり」を示す coalescing hint であり、replay しても
   * クライアントが ack 前の同一メッセージを再処理するだけ (= double dispatch)。
   * 実際の message は get_unread() で取得できるため、hint の再送は不要。
   * safety-net poll (SDK 30s) が取りこぼしをカバーする。
   *
   * **Contract**: filter は純粋・同期・例外なしで実装すること。
   * 現実装は filter の throw を想定していない (= try/catch なし)。
   * 将来 filter が外部 I/O を伴う場合は非同期版の追加を検討する。
   */
  replayFilter?: (message: JSONRPCMessage) => boolean;
}

const DEFAULT_MAX_EVENTS_PER_STREAM = 200;
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 分 (issue #290)

export class BoundedInMemoryEventStore implements EventStore {
  private readonly streams = new Map<StreamId, StoredEvent[]>();
  private readonly eventIndex = new Map<EventId, StreamId>();
  private readonly maxEventsPerStream: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly replayFilter: ((message: JSONRPCMessage) => boolean) | undefined;
  private seq = 0;

  constructor(options: BoundedInMemoryEventStoreOptions = {}) {
    this.maxEventsPerStream = options.maxEventsPerStream ?? DEFAULT_MAX_EVENTS_PER_STREAM;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    this.replayFilter = options.replayFilter;
  }

  /**
   * Event ID format: `<streamId>_<padded-seq>_<rand>`
   * - seq は単調増加で sort 可能、replay 順序保証
   * - padded-seq は 12 桁 0-pad で lexicographic sort と数値 sort を一致させる
   */
  private generateEventId(streamId: StreamId): EventId {
    this.seq += 1;
    const padded = this.seq.toString().padStart(12, '0');
    const rand = Math.random().toString(36).slice(2, 10);
    return `${streamId}_${padded}_${rand}`;
  }

  private parseSeq(eventId: EventId): number {
    const parts = eventId.split('_');
    if (parts.length < 2) return -1;
    const n = Number(parts[1]);
    return Number.isFinite(n) ? n : -1;
  }

  private pruneExpired(events: StoredEvent[]): StoredEvent[] {
    const threshold = this.now() - this.ttlMs;
    const startIdx = events.findIndex((e) => e.storedAt > threshold);
    if (startIdx <= 0) return startIdx === 0 ? events : [];
    // expired を index しているので eventIndex からも除く
    for (let i = 0; i < startIdx; i++) {
      this.eventIndex.delete(events[i]!.eventId);
    }
    return events.slice(startIdx);
  }

  async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    const eventId = this.generateEventId(streamId);
    const entry: StoredEvent = {
      eventId,
      streamId,
      message,
      storedAt: this.now(),
    };
    let bucket = this.streams.get(streamId);
    if (!bucket) {
      bucket = [];
      this.streams.set(streamId, bucket);
    }
    // expire 古い entries (TTL) を先に整理
    bucket = this.pruneExpired(bucket);
    bucket.push(entry);
    // size 上限: 古い順に捨てる
    while (bucket.length > this.maxEventsPerStream) {
      const dropped = bucket.shift();
      if (dropped) this.eventIndex.delete(dropped.eventId);
    }
    this.streams.set(streamId, bucket);
    this.eventIndex.set(eventId, streamId);
    return eventId;
  }

  async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    return this.eventIndex.get(eventId);
  }

  async replayEventsAfter(
    lastEventId: EventId,
    { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> }
  ): Promise<StreamId> {
    const streamId = this.eventIndex.get(lastEventId);
    if (!streamId) {
      return '';
    }
    const bucket = this.streams.get(streamId);
    if (!bucket || bucket.length === 0) {
      return streamId;
    }
    const lastSeq = this.parseSeq(lastEventId);
    const threshold = this.now() - this.ttlMs;
    for (const entry of bucket) {
      if (this.parseSeq(entry.eventId) <= lastSeq) continue;
      if (entry.storedAt <= threshold) continue; // TTL 切れは飛ばす (= delivery loss は容認)
      // replayFilter が false を返した event は replay しない (= issue #117 fix)。
      // event は store 済みなので event ID は連続性を保つ。hint 系通知はここで除外。
      if (this.replayFilter && !this.replayFilter(entry.message)) continue;
      await send(entry.eventId, entry.message);
    }
    return streamId;
  }

  /** test / 運用 visibility 用 */
  stats(): { streams: number; totalEvents: number } {
    let total = 0;
    for (const bucket of this.streams.values()) total += bucket.length;
    return { streams: this.streams.size, totalEvents: total };
  }
}
