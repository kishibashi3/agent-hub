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
      // 明示した path の親が無いのは typo や volume の未 mount。作ると別の場所に空の DB を作って
      // 起動してしまうので、作らずに起動失敗にする (issue #533)
      throw new Error(
        `[DB] Directory for AGENT_HUB_DB_PATH does not exist: ${dir}. ` +
          'Create it (or fix AGENT_HUB_DB_PATH / the volume mount) before starting.'
      );
    }
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
