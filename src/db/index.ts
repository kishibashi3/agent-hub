import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDatabase } from './migrations.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// データベースファイルのパス
// DB_PATH 未設定時は WARN を出して `__dirname` 相対の default path を使用する。
// Docker 環境では `DB_PATH=/data/app.db` を明示することを推奨。
// fail-fast は不要 (dev 環境では default で動くべき)。
const DB_PATH_FROM_ENV = process.env.DB_PATH;
if (!DB_PATH_FROM_ENV) {
  const defaultPath = path.join(__dirname, '../../data/app.db');
  console.warn(
    `[DB] DB_PATH is not set, using default path: ${defaultPath}. ` +
      'Set DB_PATH to an explicit absolute path (e.g. DB_PATH=/data/app.db) ' +
      'to avoid unexpected DB location, especially in Docker environments.'
  );
}
const DB_PATH = DB_PATH_FROM_ENV || path.join(__dirname, '../../data/app.db');

// データベースインスタンス（シングルトン）
let db: Database.Database | null = null;

/**
 * データベース接続を取得（シングルトン）
 */
export function getDatabase(): Database.Database {
  if (!db) {
    console.log(`[DB] Connecting to database: ${DB_PATH}`);
    db = new Database(DB_PATH);
    
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
