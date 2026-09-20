import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  evictSessionOnDisconnect,
  scheduleEvictionOnDisconnect,
  cancelPendingEviction,
  getGetCloseEvictionGraceMs,
  validateMcpEnvConfig,
  EnvConfigError,
  GET_CLOSE_EVICTION_GRACE_MS,
  GET_CLOSE_EVICTION_GRACE_MIN_MS,
  GET_CLOSE_EVICTION_GRACE_MAX_MS,
  _addSessionForTesting,
  _clearSessionsForTesting,
} from '../server.js';

/**
 * issue #342/#337: bridge プロセスが SIGKILL/OOM で abrupt に落ちた場合、
 * transport.onclose が発火せず session が sessions Map に残り続け is_online が
 * true のまま zombie 化する。GET /mcp の `req.on('close')` から呼ぶ
 * `evictSessionOnDisconnect()` の eviction 動作を検証する。
 */
describe('evictSessionOnDisconnect (issue #342/#337)', () => {
  afterEach(() => {
    _clearSessionsForTesting();
  });

  function makeMockSession(closeImpl?: () => Promise<void>) {
    return {
      transport: { close: closeImpl ?? vi.fn().mockResolvedValue(undefined) },
      server: { ping: vi.fn().mockResolvedValue(undefined) },
      userId: '@test-user',
      githubLogin: 'test-user',
      tenantDomain: 'default',
      subscribedUris: new Set(['inbox://@test-user']),
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      getConnectionGeneration: 0,
    };
  }

  it('存在する session を transport.close() → sessions.delete() の順で除去する', async () => {
    const session = makeMockSession();
    _addSessionForTesting('sid-1', session);

    const evicted = await evictSessionOnDisconnect('sid-1');

    expect(evicted).toBe(true);
    expect(session.transport.close).toHaveBeenCalledTimes(1);
  });

  it('除去後は is_online の判定元となる subscribedUris ごと sessions から消える', async () => {
    _addSessionForTesting('sid-2', makeMockSession());
    await evictSessionOnDisconnect('sid-2');

    // 再度呼んでも存在しないので false (= 冪等)
    const secondCall = await evictSessionOnDisconnect('sid-2');
    expect(secondCall).toBe(false);
  });

  it('存在しない sessionId を渡しても false を返し、例外を投げない', async () => {
    await expect(evictSessionOnDisconnect('does-not-exist')).resolves.toBe(false);
  });

  it('transport.close() が reject しても sessions からは削除される (= 切断済み transport への耐性)', async () => {
    const session = makeMockSession(vi.fn().mockRejectedValue(new Error('already closed')));
    _addSessionForTesting('sid-3', session);

    const evicted = await evictSessionOnDisconnect('sid-3');

    expect(evicted).toBe(true);
    // 2 回目呼び出しで session が既に存在しないことを確認 (= delete が実行された)
    await expect(evictSessionOnDisconnect('sid-3')).resolves.toBe(false);
  });
});

/**
 * issue #343 再設計: GET /mcp の req.on('close') は「bridge プロセス死亡」だけでなく
 * 公式 SDK client の正常な Last-Event-ID reconnect でも発火する。即時 evict だと
 * resumable reconnect (eventStore による notification 再送) が壊れるため、
 * grace period 付き eviction (scheduleEvictionOnDisconnect / cancelPendingEviction) で
 * 「一時的な GET 切断からの正常な reconnect」と「実死亡」を区別することを検証する。
 */
describe('scheduleEvictionOnDisconnect / cancelPendingEviction (issue #343 再設計)', () => {
  afterEach(() => {
    _clearSessionsForTesting();
    vi.useRealTimers();
  });

  function makeMockSession(closeImpl?: () => Promise<void>) {
    return {
      transport: { close: closeImpl ?? vi.fn().mockResolvedValue(undefined) },
      server: { ping: vi.fn().mockResolvedValue(undefined) },
      userId: '@test-user',
      githubLogin: 'test-user',
      tenantDomain: 'default',
      subscribedUris: new Set(['inbox://@test-user']),
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      getConnectionGeneration: 0,
    };
  }

  it('grace period 内に同一 session への reconnect (cancelPendingEviction) が来れば evict されない', async () => {
    vi.useFakeTimers();
    const session = makeMockSession();
    _addSessionForTesting('sid-reconnect', session);

    scheduleEvictionOnDisconnect('sid-reconnect', 0, 60_000);
    // GET 再接続が grace period 内に成立 (= 正常な Last-Event-ID reconnect)
    vi.advanceTimersByTime(30_000);
    cancelPendingEviction('sid-reconnect');
    vi.advanceTimersByTime(60_000);
    await vi.runOnlyPendingTimersAsync();

    // evict されていないので transport.close は呼ばれない
    expect(session.transport.close).not.toHaveBeenCalled();
    expect(await evictSessionOnDisconnect('sid-reconnect')).toBe(true);
  });

  it('grace period 内に reconnect が来なければ猶予期間経過後に evict される', async () => {
    vi.useFakeTimers();
    const session = makeMockSession();
    _addSessionForTesting('sid-dead', session);

    scheduleEvictionOnDisconnect('sid-dead', 0, 60_000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(session.transport.close).toHaveBeenCalledTimes(1);
    // sessions から削除済みなので再度 evict しても false
    await expect(evictSessionOnDisconnect('sid-dead')).resolves.toBe(false);
  });

  it('既に pending timer がある session に再度 schedule しても多重 timer にならない (防御的 guard)', async () => {
    vi.useFakeTimers();
    const session = makeMockSession();
    _addSessionForTesting('sid-dup', session);

    scheduleEvictionOnDisconnect('sid-dup', 0, 60_000);
    scheduleEvictionOnDisconnect('sid-dup', 0, 60_000); // 2 回目は no-op

    await vi.advanceTimersByTimeAsync(60_000);

    expect(session.transport.close).toHaveBeenCalledTimes(1);
  });

  it('存在しない sessionId に対しては何もしない (例外を投げない)', () => {
    expect(() => scheduleEvictionOnDisconnect('does-not-exist', 0, 60_000)).not.toThrow();
    expect(() => cancelPendingEviction('does-not-exist')).not.toThrow();
  });

  it('reviewer 指摘 (PR #343 race): 旧接続の close が新接続の connect より後にイベントループへ届いても、' +
    '新接続の generation と一致しないため stale close は schedule 自体を行わず、生存 session を誤 evict しない', async () => {
    vi.useFakeTimers();
    const session = makeMockSession();
    _addSessionForTesting('sid-race', session);

    // 旧接続が GET 開始した時点の generation は 0 (makeMockSession の初期値)。
    // 新接続が先に connect し、GET ハンドラ相当の generation インクリメント + cancelPendingEviction を行う
    // (この時点では旧接続の close がまだ届いていないので pending timer は存在せず no-op)。
    session.getConnectionGeneration = 1;
    cancelPendingEviction('sid-race');

    // その後に旧接続の close イベントが届く。旧接続が捕捉していた generation は 0 のまま。
    scheduleEvictionOnDisconnect('sid-race', 0, 60_000);

    await vi.advanceTimersByTimeAsync(60_000);

    // generation 不一致で schedule 自体がスキップされているため、
    // grace period 経過後も evict されず session は生存し続ける。
    expect(session.transport.close).not.toHaveBeenCalled();
    expect(await evictSessionOnDisconnect('sid-race')).toBe(true);
  });
});

/**
 * issue #355: grace 値を `AGENT_HUB_MCP_GET_CLOSE_GRACE_MS` env で上書き可能にする。
 * env 未設定時の実効値が従来どおり 60_000ms であること (= 非 breaking)、
 * 正常値が反映されること、不正値が warning 付きで既定値へ fall back することを検証する。
 */
describe('getGetCloseEvictionGraceMs (issue #355)', () => {
  const ENV = 'AGENT_HUB_MCP_GET_CLOSE_GRACE_MS';

  afterEach(() => {
    delete process.env[ENV];
    vi.restoreAllMocks();
    _clearSessionsForTesting();
    vi.useRealTimers();
  });

  it('env 未設定なら既定値 60_000ms (= SSE_KEEPALIVE_INTERVAL_MS * 4) を返す', () => {
    delete process.env[ENV];
    expect(GET_CLOSE_EVICTION_GRACE_MS).toBe(60_000);
    expect(getGetCloseEvictionGraceMs()).toBe(60_000);
  });

  it('env に正常値が入っていればその値 (ms) を返す', () => {
    process.env[ENV] = '5000';
    expect(getGetCloseEvictionGraceMs()).toBe(5_000);
  });

  // issue #384: env が set されているのに解釈できない値は、黙って既定値に落とさず
  // EnvConfigError で fail-fast する (= サイレント縮退の排除)。
  // 空文字のみが「未設定」相当 (= 既定値)。空白文字列は「set したが解釈できない値」として throw。
  it('空文字は未設定扱いで既定値を返す (warning も throw もしない)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env[ENV] = '';

    expect(getGetCloseEvictionGraceMs()).toBe(GET_CLOSE_EVICTION_GRACE_MS);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['abc', '0', '-1', '  '])(
    '不正値 %j は EnvConfigError を throw する (既定値に fall back しない)',
    (value) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      process.env[ENV] = value;

      expect(() => getGetCloseEvictionGraceMs()).toThrow(EnvConfigError);
      expect(() => getGetCloseEvictionGraceMs()).toThrow(
        /invalid AGENT_HUB_MCP_GET_CLOSE_GRACE_MS/
      );
      // 黙った fall back (= warning だけ出して既定値) はしない
      expect(warn).not.toHaveBeenCalled();
    }
  );

  // reviewer 指摘 (PR #357 Minor 1): 値域チェックが `> 0` のみだと
  // 「秒を ms と取り違えた極小値」と「setTimeout でクランプされる 32bit 超の値」が
  // どちらも無警告で通り、実質「猶予なし即時 eviction」にサイレント縮退する。
  it.each(['60', '1', String(GET_CLOSE_EVICTION_GRACE_MIN_MS - 1)])(
    '範囲下限を下回る値 %j (秒/ms 取り違え) は EnvConfigError を throw する',
    (value) => {
      process.env[ENV] = value;
      expect(() => getGetCloseEvictionGraceMs()).toThrow(EnvConfigError);
    }
  );

  it.each([
    String(GET_CLOSE_EVICTION_GRACE_MAX_MS + 1),
    '4294967296',
    '1e30',
    'Infinity',
  ])(
    '範囲上限を超える値 %j (setTimeout クランプ) は EnvConfigError を throw する',
    (value) => {
      process.env[ENV] = value;
      expect(() => getGetCloseEvictionGraceMs()).toThrow(EnvConfigError);
    }
  );

  it.each([
    String(GET_CLOSE_EVICTION_GRACE_MIN_MS),
    String(GET_CLOSE_EVICTION_GRACE_MAX_MS),
  ])('境界値 %j は有効値として受理する', (value) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env[ENV] = value;

    expect(getGetCloseEvictionGraceMs()).toBe(Number(value));
    expect(warn).not.toHaveBeenCalled();
  });

  /**
   * issue #384: getter は lazy (= 呼び出し時に env を読む) なので、起動時に
   * `validateMcpEnvConfig()` を通すことで「起動は成功し、GET 切断が起きて初めて壊れる」
   * のを防ぐ。
   */
  describe('validateMcpEnvConfig (issue #384)', () => {
    const INTERVAL_ENV = 'AGENT_HUB_MCP_ORPHAN_EVICTION_INTERVAL_MS';
    const MAX_BYTES_ENV = 'AGENT_HUB_MCP_GET_MESSAGES_MAX_BYTES';
    const DEFAULT_LIMIT_ENV = 'AGENT_HUB_MCP_GET_MESSAGES_DEFAULT_LIMIT';

    afterEach(() => {
      delete process.env[INTERVAL_ENV];
      delete process.env[MAX_BYTES_ENV];
      delete process.env[DEFAULT_LIMIT_ENV];
      vi.restoreAllMocks();
    });

    it('両 env 未設定なら何も throw しない (= 正常系)', () => {
      delete process.env[ENV];
      delete process.env[INTERVAL_ENV];
      expect(() => validateMcpEnvConfig()).not.toThrow();
    });

    it('grace env が不正値なら起動前に EnvConfigError で落ちる', () => {
      process.env[ENV] = 'abc';
      expect(() => validateMcpEnvConfig()).toThrow(EnvConfigError);
    });

    it('interval env が不正値なら起動前に EnvConfigError で落ちる', () => {
      delete process.env[ENV];
      process.env[INTERVAL_ENV] = '-1';
      expect(() => validateMcpEnvConfig()).toThrow(EnvConfigError);
    });

    // issue #388: get_messages の env も lazy getter なので、起動時にここを通さないと
    // 「起動は成功し、最初の get_messages で初めて壊れる」ことになる。
    it('get_messages の byte budget が不正値なら起動前に EnvConfigError で落ちる', () => {
      delete process.env[ENV];
      process.env[MAX_BYTES_ENV] = '0';
      expect(() => validateMcpEnvConfig()).toThrow(EnvConfigError);
    });

    it('get_messages の既定 limit が不正値なら起動前に EnvConfigError で落ちる', () => {
      delete process.env[ENV];
      process.env[DEFAULT_LIMIT_ENV] = '9999';
      expect(() => validateMcpEnvConfig()).toThrow(EnvConfigError);
    });

    it('get_messages の env 未設定時は log を出さない (= 既定値で動いている)', () => {
      delete process.env[ENV];
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      validateMcpEnvConfig();
      const logged = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).not.toContain('GET_MESSAGES');
    });

    it('get_messages の env 上書き時は実効値を起動 log に出す (issue #381 と同 pattern)', () => {
      delete process.env[ENV];
      process.env[MAX_BYTES_ENV] = '4096';
      process.env[DEFAULT_LIMIT_ENV] = '50';
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      validateMcpEnvConfig();

      const logged = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('AGENT_HUB_MCP_GET_MESSAGES_MAX_BYTES override active');
      expect(logged).toContain('4096');
      expect(logged).toContain(
        'AGENT_HUB_MCP_GET_MESSAGES_DEFAULT_LIMIT override active'
      );
      expect(logged).toContain('50');
    });

    /**
     * issue #381: env 上書きが効いている場合に実効値が起動ログに出ること。
     * 従来は不正値のときしか log が出ず、正常に上書きされた実効値は無言だった。
     */
    describe('env 上書き実効値の log 出力 (issue #381)', () => {
      it('grace env が有効値なら実効値 (ms) を 1 度だけ log に出す', () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        delete process.env[INTERVAL_ENV];
        process.env[ENV] = '5000';

        validateMcpEnvConfig();

        const graceLogs = log.mock.calls
          .map((args) => String(args[0]))
          .filter((line) => line.includes(ENV));
        expect(graceLogs).toHaveLength(1);
        expect(graceLogs[0]).toContain('5000ms');
        expect(graceLogs[0]).toContain(`default ${GET_CLOSE_EVICTION_GRACE_MS}ms`);
      });

      it('env 未設定なら追加 log を出さない (= 従来どおり無言)', () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        delete process.env[ENV];
        delete process.env[INTERVAL_ENV];

        validateMcpEnvConfig();

        expect(
          log.mock.calls.map((args) => String(args[0])).filter((line) => line.includes(ENV))
        ).toHaveLength(0);
      });

      it('空文字は未設定扱いで追加 log を出さない', () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        delete process.env[INTERVAL_ENV];
        process.env[ENV] = '';

        validateMcpEnvConfig();

        expect(
          log.mock.calls.map((args) => String(args[0])).filter((line) => line.includes(ENV))
        ).toHaveLength(0);
      });

      it('既定値と同じ値を明示 set した場合も log に出す (= drift 検出のため)', () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        delete process.env[INTERVAL_ENV];
        process.env[ENV] = String(GET_CLOSE_EVICTION_GRACE_MS);

        validateMcpEnvConfig();

        expect(
          log.mock.calls.map((args) => String(args[0])).filter((line) => line.includes(ENV))
        ).toHaveLength(1);
      });

      it('grace env が不正値なら throw するので log は出ない', () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        delete process.env[INTERVAL_ENV];
        process.env[ENV] = 'abc';

        expect(() => validateMcpEnvConfig()).toThrow(EnvConfigError);
        expect(
          log.mock.calls.map((args) => String(args[0])).filter((line) => line.includes(ENV))
        ).toHaveLength(0);
      });
    });
  });

  it('scheduleEvictionOnDisconnect の graceMs 既定値が env を反映する', async () => {
    vi.useFakeTimers();
    process.env[ENV] = '5000';
    const session = {
      transport: { close: vi.fn().mockResolvedValue(undefined) },
      server: { ping: vi.fn().mockResolvedValue(undefined) },
      userId: '@test-user',
      githubLogin: 'test-user',
      tenantDomain: 'default',
      subscribedUris: new Set(['inbox://@test-user']),
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      getConnectionGeneration: 0,
    };
    _addSessionForTesting('sid-env-grace', session);

    scheduleEvictionOnDisconnect('sid-env-grace', 0); // graceMs 省略 = env 由来の既定値

    await vi.advanceTimersByTimeAsync(4_000);
    expect(session.transport.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.transport.close).toHaveBeenCalledTimes(1);
  });
});
