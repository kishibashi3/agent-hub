import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  STARTED_AT,
  resolveGitCommit,
  resolveGitCommitAt,
  getVersionInfo,
  resetVersionInfoForTesting,
  type ExecSyncLike,
} from '../version-info.js';

/**
 * issue #47: /health version info の解決ロジック単体テスト。
 *
 * 解決優先度 (env → git exec → fallback) を、 `exec` の DI 注入で deterministic
 * に検証する。 production の `process.env` と git CLI 実環境には依存しない。
 */
describe('version-info (issue #47)', () => {
  const origEnv = { ...process.env };

  // 「git CLI が存在しない / .git が無い」 を再現する fake
  const failingExec: ExecSyncLike = () => {
    throw new Error('git not available (test fixture)');
  };

  // 固定値を返す fake (gitArgs に応じて返し分け)
  function stubbedExec(map: Record<string, string>): ExecSyncLike {
    return (cmd: string) => {
      for (const [key, value] of Object.entries(map)) {
        if (cmd.includes(key)) return value;
      }
      throw new Error(`unexpected exec: ${cmd}`);
    };
  }

  beforeEach(() => {
    resetVersionInfoForTesting();
  });

  afterEach(() => {
    // env を完全復元
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
      // 再参照しても同じ値 (= module-level const)
      const before = STARTED_AT;
      const after = STARTED_AT;
      expect(after).toBe(before);
    });
  });

  describe('resolveGitCommit', () => {
    it('env GIT_COMMIT があれば優先採用 (short SHA に揃える)', () => {
      const env = {
        GIT_COMMIT: 'a1b2c3d4e5f6789012345678901234567890abcd',
      } as NodeJS.ProcessEnv;
      expect(resolveGitCommit({ env, exec: failingExec })).toBe('a1b2c3d');
    });

    it('env GIT_COMMIT が既に 7 文字以下ならそのまま', () => {
      const env = { GIT_COMMIT: 'abc123' } as NodeJS.ProcessEnv;
      expect(resolveGitCommit({ env, exec: failingExec })).toBe('abc123');
    });

    it('env GIT_COMMIT が空文字 / 空白なら git exec fallback を呼ぶ', () => {
      const env = { GIT_COMMIT: '   ' } as NodeJS.ProcessEnv;
      const exec = stubbedExec({ 'rev-parse': 'deadbeefcafe1234\n' });
      expect(resolveGitCommit({ env, exec })).toBe('deadbee');
    });

    it('env も git もない場合は "unknown" を返す (graceful degrade)', () => {
      expect(
        resolveGitCommit({ env: {} as NodeJS.ProcessEnv, exec: failingExec })
      ).toBe('unknown');
    });

    it('git exec が空文字を返した場合も "unknown" にフォールバック', () => {
      const exec = stubbedExec({ 'rev-parse': '   \n' });
      expect(
        resolveGitCommit({ env: {} as NodeJS.ProcessEnv, exec })
      ).toBe('unknown');
    });
  });

  describe('resolveGitCommitAt', () => {
    it('env GIT_COMMIT_AT があればそのまま採用', () => {
      const env = {
        GIT_COMMIT_AT: '2026-05-19T00:32:11+00:00',
      } as NodeJS.ProcessEnv;
      expect(resolveGitCommitAt({ env, exec: failingExec })).toBe(
        '2026-05-19T00:32:11+00:00'
      );
    });

    it('env が無ければ git log fallback を呼ぶ', () => {
      const env = {} as NodeJS.ProcessEnv;
      const exec = stubbedExec({
        'log -1 --format=%cI HEAD': '2026-05-18T12:00:00+00:00\n',
      });
      expect(resolveGitCommitAt({ env, exec })).toBe(
        '2026-05-18T12:00:00+00:00'
      );
    });

    it('env も git もない場合は null を返す (graceful degrade)', () => {
      expect(
        resolveGitCommitAt({ env: {} as NodeJS.ProcessEnv, exec: failingExec })
      ).toBeNull();
    });
  });

  describe('getVersionInfo (cache 挙動)', () => {
    it('2 回呼んでも同じ instance を返す (cache hit)', () => {
      process.env.GIT_COMMIT = 'cache01';
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

    it('shape: 3 fields (git_commit / git_commit_at / started_at)', () => {
      process.env.GIT_COMMIT = 'abc1234';
      process.env.GIT_COMMIT_AT = '2026-05-19T00:00:00Z';
      const info = getVersionInfo();
      expect(info).toMatchObject({
        git_commit: 'abc1234',
        git_commit_at: '2026-05-19T00:00:00Z',
        started_at: STARTED_AT,
      });
    });
  });
});
