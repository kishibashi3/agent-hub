import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDatabase } from './migrations.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// データベースファイルのパス
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/app.db');

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
