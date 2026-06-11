/**
 * Tests for issue #301:
 *   旧 `X-User-Id` ヘッダーの deprecation 警告付きフォールバック受理。
 *
 * v0.3.0 用語統一 (#286/#287) 後も旧ヘッダーを送る client が fleet に残存しており、
 * サイレント無視すると handle override が効かず PAT owner に縮退する。
 * resolveParticipantOverride() は:
 *   - `X-Participant-Id` 優先
 *   - 無ければ `X-User-Id` にフォールバック (legacyHeaderUsed: true → 呼び出し側が WARN)
 * を保証する。auth middleware 全体の integration test は HTTP server setup が必要なため
 * 対象外 (auth_cross_persona.test.ts と同方針)。
 */

import { describe, it, expect } from 'vitest';
import { resolveParticipantOverride } from '../server.js';

describe('resolveParticipantOverride (issue #301 X-User-Id fallback)', () => {
  it('X-Participant-Id のみ → そのまま採用、legacy 扱いしない', () => {
    expect(
      resolveParticipantOverride({ 'x-participant-id': 'reviewer' })
    ).toEqual({ override: 'reviewer', legacyHeaderUsed: false });
  });

  it('X-User-Id のみ (旧 client) → フォールバック受理 + legacyHeaderUsed=true', () => {
    expect(resolveParticipantOverride({ 'x-user-id': 'scheduler' })).toEqual({
      override: 'scheduler',
      legacyHeaderUsed: true,
    });
  });

  it('両方指定 → X-Participant-Id が優先、WARN 不要', () => {
    expect(
      resolveParticipantOverride({
        'x-participant-id': 'reviewer',
        'x-user-id': 'scheduler',
      })
    ).toEqual({ override: 'reviewer', legacyHeaderUsed: false });
  });

  it('どちらも未指定 → override なし (= PAT owner に解決)', () => {
    expect(resolveParticipantOverride({})).toEqual({
      override: '',
      legacyHeaderUsed: false,
    });
  });

  it('X-Participant-Id が空文字 + X-User-Id あり → 旧ヘッダーへフォールバック', () => {
    // plugin .mcp.json の `"X-Participant-Id": "${AGENT_HUB_USER:-}"` は
    // env 未設定時に空文字を送る。この場合も旧 client の X-User-Id を生かす。
    expect(
      resolveParticipantOverride({ 'x-participant-id': '', 'x-user-id': 'admin' })
    ).toEqual({ override: 'admin', legacyHeaderUsed: true });
  });

  it('@ prefix と前後空白は正規化される (両ヘッダーとも)', () => {
    expect(
      resolveParticipantOverride({ 'x-participant-id': ' @reviewer ' })
    ).toEqual({ override: 'reviewer', legacyHeaderUsed: false });
    expect(resolveParticipantOverride({ 'x-user-id': ' @admin ' })).toEqual({
      override: 'admin',
      legacyHeaderUsed: true,
    });
  });

  it('重複ヘッダー (string[]) は未指定扱い (既存挙動を維持)', () => {
    expect(
      resolveParticipantOverride({ 'x-participant-id': ['a', 'b'] })
    ).toEqual({ override: '', legacyHeaderUsed: false });
    // participant が配列で潰れた場合でも legacy 単一値は生きる
    expect(
      resolveParticipantOverride({
        'x-participant-id': ['a', 'b'],
        'x-user-id': 'admin',
      })
    ).toEqual({ override: 'admin', legacyHeaderUsed: true });
  });

  it('空白のみの値は未指定と同じ', () => {
    expect(
      resolveParticipantOverride({ 'x-participant-id': '   ', 'x-user-id': '  ' })
    ).toEqual({ override: '', legacyHeaderUsed: false });
  });
});
