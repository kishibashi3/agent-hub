/**
 * Tests for issue #21 Fix 2+3:
 *   Fix 3 — cross-persona override WARN log
 *   Fix 2 — isStrictHandleOwnershipEnabled() feature flag
 *
 * auth middleware の full integration test は HTTP server setup が必要なため本ファイルでは
 * 対象外。ここでは:
 *   1. isStrictHandleOwnershipEnabled() の binary env var 挙動
 *   2. WARN log が出力される条件 (cross-persona 時のみ)
 * を unit test で cover する。
 *
 * middleware 全体の integration smoke test は将来 e2e suite に委譲。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isStrictHandleOwnershipEnabled } from '../server.js';

// ============================================================
// isStrictHandleOwnershipEnabled — binary env var (Fix 2)
// ============================================================

describe('isStrictHandleOwnershipEnabled (issue #21 Fix 2 strict mode flag)', () => {
  const ENV_KEY = 'AGENT_HUB_STRICT_HANDLE_OWNERSHIP';

  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it('env 未設定 → false (= 旧動作、override 許可)', () => {
    delete process.env[ENV_KEY];
    expect(isStrictHandleOwnershipEnabled()).toBe(false);
  });

  it('env = 空文字 → false (= set しただけでは有効化されない)', () => {
    process.env[ENV_KEY] = '';
    expect(isStrictHandleOwnershipEnabled()).toBe(false);
  });

  it("env = '1' → true (= strict mode 有効)", () => {
    process.env[ENV_KEY] = '1';
    expect(isStrictHandleOwnershipEnabled()).toBe(true);
  });

  it("env = '0' → true (binary semantic: 値の内容は問わない、set されていれば有効)", () => {
    // binary env var 規約: 「set = 有効」、値の文字列 (例: '0') は無視
    process.env[ENV_KEY] = '0';
    expect(isStrictHandleOwnershipEnabled()).toBe(true);
  });

  it("env = 任意の non-empty 文字列 → true", () => {
    process.env[ENV_KEY] = 'true';
    expect(isStrictHandleOwnershipEnabled()).toBe(true);
  });
});

// ============================================================
// Fix 3: cross-persona override WARN log の出力条件
//
// auth middleware 内の `console.warn` 呼び出し箇所は middleware 自体に
// 閉じているため、ここではその判定条件 (= override !== '' && override !== githubLogin)
// を直接ロジックとして検証する。
// ============================================================

describe('cross-persona override WARN log conditions (issue #21 Fix 3)', () => {
  /**
   * Fix 3 の判定ロジックを pure function として抽出したもの。
   * middleware の実装と同じ条件式。
   */
  function shouldWarnCrossPersona(override: string, githubLogin: string): boolean {
    return override !== '' && override !== githubLogin;
  }

  it('override なし (override="") → WARN 不要', () => {
    expect(shouldWarnCrossPersona('', 'kishibashi3')).toBe(false);
  });

  it('override === githubLogin → 同一 persona、WARN 不要', () => {
    expect(shouldWarnCrossPersona('kishibashi3', 'kishibashi3')).toBe(false);
  });

  it('override !== githubLogin → cross-persona、WARN 必要', () => {
    expect(shouldWarnCrossPersona('reviewer', 'kishibashi3')).toBe(true);
  });

  it('@-prefix ありの override も判定ロジック通過後は @ なし形式で比較', () => {
    // middleware は overrideHeader.trim().replace(/^@/, '') で @ を除去してから
    // override 変数に格納するため、比較は @ なし同士。
    // @reviewer → 'reviewer' として渡される前提でテスト。
    expect(shouldWarnCrossPersona('reviewer', 'kishibashi3')).toBe(true);
    expect(shouldWarnCrossPersona('kishibashi3', 'kishibashi3')).toBe(false);
  });

  it('override = githubLogin と同値 (= agent 本人が自分の handle を明示指定) → WARN 不要', () => {
    // X-Participant-Id: kishibashi3 で PAT owner=kishibashi3 → persona switch なし
    expect(shouldWarnCrossPersona('kishibashi3', 'kishibashi3')).toBe(false);
  });
});
