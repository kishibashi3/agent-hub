/**
 * /health endpoint version info (= issue #47 / operator @ope-ultp1635 delegation).
 *
 * 「running process がどの commit を抱えているか」「いつから起動中か」を `/health`
 * から外から判別可能にするための utility。 古い build が動き続けて新規 fix が
 * 反映されていない silent staleness 状態を operator が検知できることが狙い。
 *
 * ## 解決戦略 (= env-only、 operator follow-up DM `b5fdfe78` 反映)
 *
 * - **production (Docker / fly.io)**: build 時に `ARG GIT_COMMIT` / `ARG GIT_COMMIT_AT`
 *   で env var に焼き込む。`.git` を image に含めない slim image でも commit が判明する。
 * - **env が無い場合 (dev `tsx watch` 等)**: `null` を返す。 runtime `git rev-parse` は
 *   **行わない** (= operator が明示的に却下、 開発時 git 実行コストと予測不能性を回避)。
 * - **field は常に present** (= 値が `null` でも key 自体は残す)。 これにより client は
 *   「未対応サーバー (= key 自体なし)」 と 「対応サーバーだが env 未設定 (= null)」 を区別できる。
 *
 * `started_at` は module load の瞬間に固定する constant (= 例外なし、 process 寿命 = 値固定)。
 */

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
 * `git_commit` / `git_commit_at` は env 未設定時は `null` (= field 自体は present)。
 */
export interface VersionInfo {
  /** env `GIT_COMMIT` をそのまま採用、 未設定なら `null`。 */
  git_commit: string | null;
  /** env `GIT_COMMIT_AT` をそのまま採用、 未設定なら `null` (ISO 8601 想定)。 */
  git_commit_at: string | null;
  /** server process が起動した時刻 (ISO 8601)。 module load 時刻で固定。 */
  started_at: string;
}

/**
 * env から非空文字列を取り出す内部 helper。 空白のみ / 未設定はすべて `null` に揃える。
 */
function readEnvString(env: NodeJS.ProcessEnv, key: string): string | null {
  const raw = env[key];
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * `GIT_COMMIT` env を解決する。
 *
 * - 未設定 / 空白 → `null`
 * - 設定あり → trim してそのまま採用 (= operator が短 SHA を流すか長 SHA を流すかは操作側の選択)
 *
 * operator @ope-ultp1635 follow-up DM `b5fdfe78` 反映: runtime exec fallback なし、
 * env 未設定時は `null` (= 「未対応サーバー」 と 「env 未設定の対応サーバー」 を client が区別できる)。
 */
export function resolveGitCommit(env: NodeJS.ProcessEnv = process.env): string | null {
  return readEnvString(env, 'GIT_COMMIT');
}

/**
 * `GIT_COMMIT_AT` env を解決する。
 *
 * - 未設定 / 空白 → `null`
 * - 設定あり → trim してそのまま採用 (= ISO 8601 想定だが parse は行わず透過)
 */
export function resolveGitCommitAt(env: NodeJS.ProcessEnv = process.env): string | null {
  return readEnvString(env, 'GIT_COMMIT_AT');
}

/**
 * version info を 1 回だけ評価して module-level に cache する。
 *
 * `/health` は health check で頻繁に呼ばれるため、 env 参照を毎回走らせない。
 * 値は server process 寿命中は不変なので OK (env を runtime に書き換えても反映しないのが意図)。
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
