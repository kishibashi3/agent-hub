import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  STARTED_AT,
  resolveGitCommit,
  resolveGitCommitAt,
  getVersionInfo,
  resetVersionInfoForTesting,
} from '../version-info.js';

/**
 * issue #47: /health version info の解決ロジック単体テスト。
 *
 * 解決戦略は env-only (= operator follow-up DM `b5fdfe78` 反映、 runtime exec fallback なし):
 * - env 設定あり → trim してそのまま採用
 * - env 未設定 / 空白 → `null` (= `'unknown'` ではなく、 field 自体は present)
 */
describe('version-info (issue #47)', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    resetVersionInfoForTesting();
  });

  afterEach(() => {
    // env を完全復元 (= 他 test の汚染を防ぐ)
    for (const key of Object.keys(process.env)) {
      if (!(key in origEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, origEnv);
    resetVersionInfoForTesting();
  });

  describe('STARTED_AT', () => {
    it('module load 時に ISO 8601 で固定される', () => {
      expect(STARTED_AT).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
      );
      const before = STARTED_AT;
      const after = STARTED_AT;
      expect(after).toBe(before);
    });
  });

  describe('resolveGitCommit', () => {
    it('env GIT_COMMIT が設定されていれば trim してそのまま採用', () => {
      const env = { GIT_COMMIT: '091ba92' } as NodeJS.ProcessEnv;
      expect(resolveGitCommit(env)).toBe('091ba92');
    });

    it('full SHA も透過する (= operator が CI で $GITHUB_SHA を流す想定でも壊さない)', () => {
      const env = {
        GIT_COMMIT: 'a1b2c3d4e5f6789012345678901234567890abcd',
      } as NodeJS.ProcessEnv;
      expect(resolveGitCommit(env)).toBe(
        'a1b2c3d4e5f6789012345678901234567890abcd'
      );
    });

    it('前後 whitespace は trim される', () => {
      const env = { GIT_COMMIT: '  091ba92  \n' } as NodeJS.ProcessEnv;
      expect(resolveGitCommit(env)).toBe('091ba92');
    });

    it('env 未設定なら null (= "unknown" ではなく)', () => {
      expect(resolveGitCommit({} as NodeJS.ProcessEnv)).toBeNull();
    });

    it('env が空文字 / 空白のみなら null', () => {
      expect(
        resolveGitCommit({ GIT_COMMIT: '' } as NodeJS.ProcessEnv)
      ).toBeNull();
      expect(
        resolveGitCommit({ GIT_COMMIT: '   \n' } as NodeJS.ProcessEnv)
      ).toBeNull();
    });
  });

  describe('resolveGitCommitAt', () => {
    it('env GIT_COMMIT_AT が設定されていれば trim してそのまま採用', () => {
      const env = {
        GIT_COMMIT_AT: '2026-05-18T12:34:00Z',
      } as NodeJS.ProcessEnv;
      expect(resolveGitCommitAt(env)).toBe('2026-05-18T12:34:00Z');
    });

    it('env 未設定なら null', () => {
      expect(resolveGitCommitAt({} as NodeJS.ProcessEnv)).toBeNull();
    });

    it('env が空白のみなら null', () => {
      expect(
        resolveGitCommitAt({ GIT_COMMIT_AT: '   ' } as NodeJS.ProcessEnv)
      ).toBeNull();
    });
  });

  describe('getVersionInfo (cache 挙動)', () => {
    it('2 回呼んでも同じ instance を返す (cache hit)', () => {
      process.env.GIT_COMMIT = '091ba92';
      const first = getVersionInfo();
      const second = getVersionInfo();
      expect(second).toBe(first);
    });

    it('reset 後は再評価される', () => {
      process.env.GIT_COMMIT = 'before1';
      const first = getVersionInfo();
      expect(first.git_commit).toBe('before1');

      resetVersionInfoForTesting();
      process.env.GIT_COMMIT = 'after01';
      const second = getVersionInfo();
      expect(second.git_commit).toBe('after01');
      expect(second).not.toBe(first);
    });

    it('shape: 3 fields all present (= field 未対応サーバーと区別可能にする)', () => {
      delete process.env.GIT_COMMIT;
      delete process.env.GIT_COMMIT_AT;
      const info = getVersionInfo();
      expect(info).toMatchObject({
        git_commit: null,
        git_commit_at: null,
        started_at: STARTED_AT,
      });
      // field 自体は常に present (= key として存在する)
      expect('git_commit' in info).toBe(true);
      expect('git_commit_at' in info).toBe(true);
      expect('started_at' in info).toBe(true);
    });

    it('env 設定時: env 値が反映される', () => {
      process.env.GIT_COMMIT = '091ba92';
      process.env.GIT_COMMIT_AT = '2026-05-18T12:34:00Z';
      const info = getVersionInfo();
      expect(info).toMatchObject({
        git_commit: '091ba92',
        git_commit_at: '2026-05-18T12:34:00Z',
        started_at: STARTED_AT,
      });
    });
  });
});
