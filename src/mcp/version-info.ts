/**
 * /health endpoint version info (= issue #47 / operator delegation).
 *
 * 「running process がどの commit を抱えているか」「いつから起動中か」を `/health`
 * から外から判別可能にするための utility。 古い build が動き続けて新規 fix が
 * 反映されていない silent staleness 状態を operator が検知できることが狙い。
 *
 * ## 解決戦略 (= hybrid)
 *
 * - **production (Docker / fly.io)**: build 時に `ARG GIT_COMMIT` / `ARG GIT_COMMIT_AT`
 *   で env var に焼き込む。`.git` を image に含めない slim image でも commit が判明する。
 * - **dev (`tsx watch`)**: env var が無ければ runtime に `git rev-parse HEAD` で fallback。
 *   `.git` が存在する dev 環境では追加設定不要で動く。
 * - **git unavailable 時** (git CLI が無い / `.git` が無い等): `git_commit: 'unknown'` /
 *   `git_commit_at: null` で graceful degrade。 throw しない (= /health は常に 200 を返す契約)。
 *
 * `started_at` は module load の瞬間に固定する constant (= 例外なし、 process 寿命 = 値固定)。
 */

import { execSync as nodeExecSync } from 'node:child_process';

/**
 * server process が起動した時刻 (ISO 8601)。
 *
 * module top-level で 1 度だけ評価される。 server restart → module 再 import → 新しい値
 * になる契約。 `/health` での 「いつから起動中か」 query にそのまま使う。
 */
export const STARTED_AT: string = new Date().toISOString();

/**
 * version info をまとめた immutable な型。
 *
 * `/health` レスポンスにそのまま spread される想定。 field 追加は backward-compat。
 */
export interface VersionInfo {
  /** short SHA (7 chars)、 解決失敗時は `'unknown'`。 */
  git_commit: string;
  /** commit date (ISO 8601)、 解決失敗時は `null`。 */
  git_commit_at: string | null;
  /** server process が起動した時刻 (ISO 8601)。 */
  started_at: string;
}

/**
 * `execSync` の inject 可能 alias。
 *
 * test では「git が無い環境」を再現するために throw する fake を渡せる。
 * production 用 default は node:child_process の `execSync`。
 */
export type ExecSyncLike = (cmd: string, options?: unknown) => string | Buffer;

/**
 * env var を読みつつ runtime fallback で解決する内部 helper。
 *
 * - env がある → trim して採用
 * - env が無い → `git` を exec で実行
 * - exec 失敗 → fallback 値
 */
function resolveFromEnvOrGit(opts: {
  envVar: string;
  gitArgs: string[];
  fallback: string | null;
  env: NodeJS.ProcessEnv;
  exec: ExecSyncLike;
  /** exec 出力を後処理する (例: short SHA 化)。 default は trim のみ。 */
  postprocess?: (raw: string) => string;
}): string | null {
  const fromEnv = opts.env[opts.envVar];
  if (fromEnv && fromEnv.trim()) {
    const value = fromEnv.trim();
    return opts.postprocess ? opts.postprocess(value) : value;
  }
  try {
    const out = opts.exec(`git ${opts.gitArgs.join(' ')}`, {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 2000,
    });
    const raw = typeof out === 'string' ? out.trim() : out.toString('utf8').trim();
    if (!raw) return opts.fallback;
    return opts.postprocess ? opts.postprocess(raw) : raw;
  } catch {
    return opts.fallback;
  }
}

/**
 * git commit (short SHA、 7 chars) を解決する。
 *
 * 解決優先度:
 * 1. env `GIT_COMMIT` (= production build で焼き込む想定)
 * 2. runtime `git rev-parse --short=7 HEAD` (= dev 環境向け fallback)
 * 3. fallback `'unknown'`
 */
export function resolveGitCommit(opts?: {
  env?: NodeJS.ProcessEnv;
  exec?: ExecSyncLike;
}): string {
  return (
    resolveFromEnvOrGit({
      envVar: 'GIT_COMMIT',
      gitArgs: ['rev-parse', '--short=7', 'HEAD'],
      fallback: 'unknown',
      env: opts?.env ?? process.env,
      exec: opts?.exec ?? nodeExecSync,
      // env で full SHA が渡された場合 (= CI で `$GITHUB_SHA` をそのまま渡す等) も
      // short SHA に揃える。 既に 7 文字以下ならそのまま。
      postprocess: (raw) => (raw.length > 7 ? raw.slice(0, 7) : raw),
    }) ?? 'unknown'
  );
}

/**
 * git commit date (ISO 8601 / commit date) を解決する。
 *
 * 解決優先度:
 * 1. env `GIT_COMMIT_AT` (= production build で焼き込む想定、 ISO 8601 文字列)
 * 2. runtime `git log -1 --format=%cI HEAD` (= commit date in strict ISO 8601)
 * 3. fallback `null`
 */
export function resolveGitCommitAt(opts?: {
  env?: NodeJS.ProcessEnv;
  exec?: ExecSyncLike;
}): string | null {
  return resolveFromEnvOrGit({
    envVar: 'GIT_COMMIT_AT',
    gitArgs: ['log', '-1', '--format=%cI', 'HEAD'],
    fallback: null,
    env: opts?.env ?? process.env,
    exec: opts?.exec ?? nodeExecSync,
  });
}

/**
 * version info を 1 回だけ評価して module-level に cache する。
 *
 * `/health` は health check で頻繁に呼ばれるため、 git exec を毎回走らせない。
 * 値は server process 寿命中は不変なので OK。
 *
 * test 用に `resetVersionInfoForTesting()` で cache を捨てられる。
 */
let cachedVersionInfo: VersionInfo | null = null;

export function getVersionInfo(): VersionInfo {
  if (!cachedVersionInfo) {
    cachedVersionInfo = {
      git_commit: resolveGitCommit(),
      git_commit_at: resolveGitCommitAt(),
      started_at: STARTED_AT,
    };
  }
  return cachedVersionInfo;
}

/** test 用: cache を捨てる。 production import 禁止。 */
export function resetVersionInfoForTesting(): void {
  cachedVersionInfo = null;
}
