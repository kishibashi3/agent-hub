import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDatabase } from './migrations.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// データベースファイルのパス
// AGENT_HUB_DB_PATH 未設定時は WARN を出して `__dirname` 相対の default path を使用する。
// Docker 環境では `AGENT_HUB_DB_PATH=/app/data/app.db` を明示することを推奨。
// fail-fast は不要 (dev 環境では default で動くべき)。
// module の読み込み時ではなく getDatabase() の初回呼び出しで読む。entrypoint の
// dotenv.config() は import の評価より後に走るので、読み込み時に読むと .env の値が効かない (issue #470)。
function resolveDbPath(): { dbPath: string; explicit: boolean } {
  const fromEnv = process.env.AGENT_HUB_DB_PATH;
  if (fromEnv) return { dbPath: fromEnv, explicit: true };
  const defaultPath = path.join(__dirname, '../../data/app.db');
  console.warn(
    `[DB] AGENT_HUB_DB_PATH is not set, using default path: ${defaultPath}. ` +
      'Set AGENT_HUB_DB_PATH to an explicit absolute path (e.g. AGENT_HUB_DB_PATH=/app/data/app.db) ' +
      'to avoid unexpected DB location, especially in Docker environments.'
  );
  return { dbPath: defaultPath, explicit: false };
}

// image が DB を置く dir。image は mkdir 済みなので、volume の mount を忘れても存在し、container layer 上に
// DB を作って起動してしまう (issue #537)。判定するのは DB の親 dir がこの path のときだけ。host で動かす開発環境
// の ./data などは mount point ではないので対象外にする
const DB_MOUNT_DIR = '/app/data';
const MOUNTINFO_PATH = '/proc/self/mountinfo';

// mountinfo の 5 列目 (process の root から見た mount point) が dir と一致する行があれば mount point。
// 空白などは octal escape (`\040`) で書かれるが、/app/data には含まれないので decode しない
function isMountPoint(dir: string, mountinfo: string): boolean {
  return mountinfo.split('\n').some((line) => line.split(' ')[4] === dir);
}

/**
 * DB の親 dir が /app/data なのに mount point でなければ WARN を出す。
 * AGENT_HUB_REQUIRE_DB_MOUNT (空でない値) を設定していれば、mount point でないときと
 * mountinfo が読めず判定できないときに throw する。未設定で判定できないときは何もしない (issue #537)
 */
export function checkDbMount(
  dir: string,
  readMountinfo: () => string = () => fs.readFileSync(MOUNTINFO_PATH, 'utf8')
): void {
  if (path.resolve(dir) !== DB_MOUNT_DIR) return;
  const required =
    process.env.AGENT_HUB_REQUIRE_DB_MOUNT !== undefined && process.env.AGENT_HUB_REQUIRE_DB_MOUNT !== '';

  let mountinfo: string;
  try {
    mountinfo = readMountinfo();
  } catch (err) {
    if (!required) return;
    throw new Error(
      `[DB] AGENT_HUB_REQUIRE_DB_MOUNT is set, but ${MOUNTINFO_PATH} cannot be read ` +
        `(${(err as Error).message}), so whether ${DB_MOUNT_DIR} is a mounted volume cannot be determined. ` +
        'Refusing to start.'
    );
  }
  if (isMountPoint(DB_MOUNT_DIR, mountinfo)) return;

  const message =
    `${DB_MOUNT_DIR} is not a mounted volume, so the DB is created in the container's writable layer ` +
    'and will be lost when the container is recreated. ' +
    `Mount a volume at ${DB_MOUNT_DIR} (e.g. docker run -v $(pwd)/data:${DB_MOUNT_DIR}, or ./data:${DB_MOUNT_DIR} in compose).`;
  if (required) {
    throw new Error(`[DB] ${message} Refusing to start because AGENT_HUB_REQUIRE_DB_MOUNT is set.`);
  }
  console.warn(
    `[DB] WARNING: ${message} Set AGENT_HUB_REQUIRE_DB_MOUNT=1 to refuse to start in this case.`
  );
}

// データベースインスタンス（シングルトン）
let db: Database.Database | null = null;

/**
 * データベース接続を取得（シングルトン）
 */
export function getDatabase(): Database.Database {
  if (!db) {
    const { dbPath, explicit } = resolveDbPath();
    console.log(`[DB] Connecting to database: ${dbPath}`);
    const dir = path.dirname(dbPath);
    if (!explicit) {
      // fresh checkout では data/ が無いので、default path のときは親ディレクトリを作ってから開く (issue #470)
      fs.mkdirSync(dir, { recursive: true });
    } else if (!fs.existsSync(dir)) {
      // 明示した path の親が無いのは typo や、設定した path と volume の mount 先の不一致。作ると別の場所に
      // 空の DB を作って起動してしまうので、作らずに起動失敗にする (issue #533)。image は /app/data を
      // mkdir 済みなので、mount 忘れそのものはここでは捕まらない (issue #537)
      throw new Error(
        `[DB] Directory for AGENT_HUB_DB_PATH does not exist: ${dir}. ` +
          'Create it, or fix AGENT_HUB_DB_PATH (typo?) or the volume mount target so they match, before starting.'
      );
    }
    checkDbMount(dir);
    db = new Database(dbPath);
    
    // データベース初期化とマイグレーション適用
    initDatabase(db);
  }
  return db;
}

/**
 * データベース接続を閉じる（テスト用・アプリケーション終了時）
 */
export function closeDatabase(): void {
  if (db) {
    console.log('[DB] Closing database connection');
    db.close();
    db = null;
  }
}

export default { getDatabase, closeDatabase };
