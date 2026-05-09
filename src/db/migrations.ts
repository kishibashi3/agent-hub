import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface Migration {
  version: number;
  description: string;
  sql: string;
}

interface SchemaVersion {
  version: number;
  applied_at: string;
  description: string;
}

/**
 * schema_version テーブルから現在のDBバージョンを取得
 * テーブルが存在しない場合は 0 を返す
 */
export function getCurrentVersion(db: Database.Database): number {
  try {
    const result = db
      .prepare(
        `SELECT version FROM schema_version ORDER BY version DESC LIMIT 1`
      )
      .get() as SchemaVersion | undefined;

    return result?.version ?? 0;
  } catch (error) {
    // schema_version テーブルが存在しない場合
    if (error instanceof Error && error.message.includes('no such table')) {
      return 0;
    }
    throw error;
  }
}

/**
 * schema.sql ファイルを読み込み、SQL文を解析して返す
 */
function loadSchemaFile(): string {
  const schemaPath = path.join(__dirname, 'schema.sql');
  
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Schema file not found: ${schemaPath}`);
  }

  return fs.readFileSync(schemaPath, 'utf-8');
}

/**
 * SQL文を個別のステートメントに分割
 * コメントと空行を除去し、セミコロンで区切る
 */
function parseSqlStatements(sql: string): string[] {
  // コメント行を削除（-- で始まる行）
  const withoutLineComments = sql
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n');

  // ブロックコメントを削除（/* */ 形式）
  const withoutBlockComments = withoutLineComments.replace(
    /\/\*[\s\S]*?\*\//g,
    ''
  );

  // セミコロンで分割し、空のステートメントを除去
  return withoutBlockComments
    .split(';')
    .map(stmt => stmt.trim())
    .filter(stmt => stmt.length > 0);
}

/**
 * 単一のマイグレーションを実行
 * トランザクション内で実行し、失敗時は自動ロールバック
 */
export function runMigration(
  db: Database.Database,
  migration: Migration
): void {
  console.log(
    `[Migration] Applying version ${migration.version}: ${migration.description}`
  );

  // トランザクション開始
  const transaction = db.transaction(() => {
    // SQLステートメントを解析して実行
    const statements = parseSqlStatements(migration.sql);

    for (const statement of statements) {
      try {
        db.prepare(statement).run();
      } catch (error) {
        console.error(`[Migration] Failed to execute statement:`);
        console.error(statement);
        throw error;
      }
    }

    // マイグレーション記録を更新
    // schema_version テーブルが既に存在する前提
    // （初回マイグレーションでテーブル作成とINSERTが含まれている）
    console.log(
      `[Migration] Version ${migration.version} applied successfully`
    );
  });

  try {
    transaction();
  } catch (error) {
    console.error(
      `[Migration] Failed to apply version ${migration.version}:`,
      error
    );
    throw error;
  }
}

/**
 * 未適用のマイグレーションを順序通りに適用
 *
 * - 新規 DB (currentVersion === 0): schema.sql を一括実行（最新バージョンで作成）
 * - 既存 DB (currentVersion < targetVersion): 段階的に ALTER 系マイグレーションを適用
 */
export function applyMigrations(db: Database.Database): void {
  const currentVersion = getCurrentVersion(db);
  console.log(`[Migration] Current database version: ${currentVersion}`);

  // schema.sql のバージョン（ファイル内の INSERT 文と一致させる）
  const targetVersion = 5;

  if (currentVersion >= targetVersion) {
    console.log('[Migration] Database is up to date');
    return;
  }

  // 新規 DB (v0) → 最新スキーマで一括作成
  if (currentVersion === 0) {
    runMigration(db, {
      version: targetVersion,
      description: 'fresh install at latest schema',
      sql: loadSchemaFile(),
    });
    console.log(
      `[Migration] Migration completed. Database version: ${targetVersion}`
    );
    return;
  }

  // v2 → v3: participants に owner 列を追加
  if (currentVersion < 3) {
    runMigration(db, {
      version: 3,
      description: 'add owner column to participants',
      sql: `
        ALTER TABLE participants ADD COLUMN owner TEXT;
        INSERT INTO schema_version (version, description)
        VALUES (3, 'add owner column to participants');
      `,
    });
  }

  // v3 → v4: participants に mode 列を追加（worker type 宣言）
  if (currentVersion < 4) {
    runMigration(db, {
      version: 4,
      description: 'add mode column to participants',
      sql: `
        ALTER TABLE participants ADD COLUMN mode TEXT;
        INSERT INTO schema_version (version, description)
        VALUES (4, 'add mode column to participants');
      `,
    });
  }

  // v4 → v5: participants に deleted_at 列を追加（soft delete 対応）
  if (currentVersion < 5) {
    runMigration(db, {
      version: 5,
      description: 'add deleted_at column to participants',
      sql: `
        ALTER TABLE participants ADD COLUMN deleted_at TEXT;
        INSERT INTO schema_version (version, description)
        VALUES (5, 'add deleted_at column to participants');
      `,
    });
  }

  console.log(
    `[Migration] Migration completed. Database version: ${targetVersion}`
  );
}

/**
 * データベースの初期化とマイグレーション適用
 * アプリケーション起動時に呼び出す
 */
export function initDatabase(db: Database.Database): void {
  console.log('[Migration] Initializing database...');

  try {
    // WAL モードを有効化（並行アクセス性能向上）
    db.pragma('journal_mode = WAL');
    
    // 外部キー制約を有効化
    db.pragma('foreign_keys = ON');

    // マイグレーション適用
    applyMigrations(db);

    console.log('[Migration] Database initialization completed');
  } catch (error) {
    console.error('[Migration] Database initialization failed:', error);
    throw error;
  }
}

/**
 * マイグレーションのロールバック（将来の拡張用）
 * 現在の実装では未サポート
 */
export function rollbackMigration(
  _db: Database.Database,
  _targetVersion: number
): void {
  throw new Error(
    'Rollback is not implemented yet. Please restore from backup.'
  );
}
