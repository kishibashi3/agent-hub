import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';

/**
 * issue #409: stale な `mcp-session-id` 付きの POST /mcp は 404 を返し、session を作らない。
 *
 * 以前の auto-reissue (#68) は新 session を作ったうえで元 request を stale sid のまま
 * transport に渡していたため、client には 404 だけが返り、server 側に session がリークしていた。
 * 本 file は express app に実 HTTP (supertest) で request を送り、
 *   - stale sid → 404 + SDK と同じ body、`mcp-session-id` header なし
 *   - `/health` の sessions が増えない (= リークしない)
 *   - 404 のあと client が initialize し直せば新 sid で通常どおり動く
 * を確認する。
 */

// DB は test ごとの in-memory。getDatabase() が module load 時に path を読むので hoisted で先に設定する。
vi.hoisted(() => {
  process.env.AGENT_HUB_DB_PATH = ':memory:';
});

// PAT 検証 (= GitHub API) を固定 user に差し替える。
vi.mock('../../auth/github-oauth.js', () => ({
  fetchUserInfo: vi.fn(async () => ({ login: 'reissue-tester', id: 1 })),
  fetchUserOrgs: vi.fn(async () => []),
  verifyOrgMembership: vi.fn(() => true),
}));

import {
  MCPServer,
  SESSION_NOT_FOUND_BODY,
  setEditionConfigForTesting,
  resetEditionConfigForTesting,
  _clearSessionsForTesting,
} from '../server.js';
import { resolveEdition } from '../../edition.js';
import { closeDatabase } from '../../db/index.js';

const AUTH = { Authorization: 'Bearer test-pat' };
const ACCEPT = { Accept: 'application/json, text/event-stream' };
const STALE_SID = '11111111-2222-3333-4444-555555555555';

const initializeBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'session-not-found-test', version: '1.0' },
  },
};

const toolsListBody = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

describe('POST /mcp with stale session id (issue #409)', () => {
  let app: ReturnType<MCPServer['getApp']>;

  async function sessionCount(): Promise<number> {
    const res = await request(app).get('/health');
    return res.body.sessions as number;
  }

  async function initialize(): Promise<string> {
    const res = await request(app).post('/mcp').set(AUTH).set(ACCEPT).send(initializeBody);
    expect(res.status).toBe(200);
    const sid = res.headers['mcp-session-id'];
    expect(typeof sid).toBe('string');
    await request(app)
      .post('/mcp')
      .set(AUTH)
      .set(ACCEPT)
      .set('mcp-session-id', sid)
      .send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      .expect(202);
    return sid;
  }

  beforeAll(() => {
    setEditionConfigForTesting(resolveEdition({ AGENT_HUB_EDITION: 'private' }));
    app = new MCPServer(0).getApp();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    _clearSessionsForTesting();
  });

  afterAll(() => {
    resetEditionConfigForTesting();
    closeDatabase();
    vi.restoreAllMocks();
  });

  it('stale sid の tools/list は 404 + SDK と同じ body を返し、mcp-session-id header を付けない', async () => {
    const res = await request(app)
      .post('/mcp')
      .set(AUTH)
      .set(ACCEPT)
      .set('mcp-session-id', STALE_SID)
      .send(toolsListBody);

    expect(res.status).toBe(404);
    expect(res.body).toEqual(SESSION_NOT_FOUND_BODY);
    expect(res.headers['mcp-session-id']).toBeUndefined();
  });

  it('stale sid の request を繰り返しても sessions は増えない (= リークしない)', async () => {
    const before = await sessionCount();
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/mcp')
        .set(AUTH)
        .set(ACCEPT)
        .set('mcp-session-id', STALE_SID)
        .send(toolsListBody)
        .expect(404);
    }
    expect(await sessionCount()).toBe(before);
  });

  it('404 のあと initialize し直せば、新しい sid で tools/list が通る (= client の回復経路)', async () => {
    await request(app)
      .post('/mcp')
      .set(AUTH)
      .set(ACCEPT)
      .set('mcp-session-id', STALE_SID)
      .send(toolsListBody)
      .expect(404);

    const before = await sessionCount();
    const sid = await initialize();
    expect(sid).not.toBe(STALE_SID);
    expect(await sessionCount()).toBe(before + 1);

    const res = await request(app)
      .post('/mcp')
      .set(AUTH)
      .set(ACCEPT)
      .set('mcp-session-id', sid)
      .send(toolsListBody);
    expect(res.status).toBe(200);
    expect(res.text).toContain('"tools"');
    expect(await sessionCount()).toBe(before + 1);
  });

  it('stale sid + initialize は従来どおり 400 (= 変更なし)', async () => {
    const before = await sessionCount();
    const res = await request(app)
      .post('/mcp')
      .set(AUTH)
      .set(ACCEPT)
      .set('mcp-session-id', STALE_SID)
      .send(initializeBody);
    expect(res.status).toBe(400);
    expect(await sessionCount()).toBe(before);
  });
});
