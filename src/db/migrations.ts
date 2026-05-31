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
  // 行頭コメント行を除去し、inline コメント (--) も切り詰める
  // ※ inline コメント内に ';' が含まれると split(';') が壊れるため両方処理する
  const withoutLineComments = sql
    .split('\n')
    .map(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('--')) return ''; // 行全体がコメント
      const inlineIdx = line.indexOf('--');
      return inlineIdx >= 0 ? line.substring(0, inlineIdx) : line; // inline コメントを除去
    })
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
  const targetVersion = 12;

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

  // v5 → v6: multi-tenant 化 (tenants table + tenant_id 列 + 複合 PK)
  // SQLite は ALTER で PK 変更できないので、各テーブル recreate + データ backfill。
  // FK 整合のため foreign_keys を一時 OFF。既存データは tenant_id='default' 扱い。
  if (currentVersion < 6) {
    runMigration(db, {
      version: 6,
      description: 'multi-tenant: tenants table + tenant_id columns + composite PKs',
      sql: `
        -- FK を一時無効化 (recreate 中の整合維持のため)
        PRAGMA foreign_keys = OFF;

        -- tenants 登録テーブル新設
        CREATE TABLE tenants (
          domain TEXT PRIMARY KEY,
          owner TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
        );
        INSERT INTO tenants (domain, owner) VALUES ('default', NULL);

        -- participants
        CREATE TABLE participants_new (
          tenant_id TEXT NOT NULL,
          name TEXT NOT NULL,
          display_name TEXT,
          owner TEXT,
          mode TEXT,
          deleted_at TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
          PRIMARY KEY (tenant_id, name)
        );
        INSERT INTO participants_new (tenant_id, name, display_name, owner, mode, deleted_at, created_at)
        SELECT 'default', name, display_name, owner, mode, deleted_at, created_at FROM participants;
        DROP TABLE participants;
        ALTER TABLE participants_new RENAME TO participants;

        -- teams
        CREATE TABLE teams_new (
          tenant_id TEXT NOT NULL,
          name TEXT NOT NULL,
          owner TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
          PRIMARY KEY (tenant_id, name),
          FOREIGN KEY (tenant_id, owner) REFERENCES participants(tenant_id, name)
        );
        INSERT INTO teams_new (tenant_id, name, owner, created_at)
        SELECT 'default', name, owner, created_at FROM teams;
        DROP TABLE teams;
        ALTER TABLE teams_new RENAME TO teams;

        -- team_members
        CREATE TABLE team_members_new (
          tenant_id TEXT NOT NULL,
          team_name TEXT NOT NULL,
          member_name TEXT NOT NULL,
          joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
          PRIMARY KEY (tenant_id, team_name, member_name),
          FOREIGN KEY (tenant_id, team_name) REFERENCES teams(tenant_id, name) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, member_name) REFERENCES participants(tenant_id, name)
        );
        INSERT INTO team_members_new (tenant_id, team_name, member_name, joined_at)
        SELECT 'default', team_name, member_name, joined_at FROM team_members;
        DROP TABLE team_members;
        ALTER TABLE team_members_new RENAME TO team_members;
        CREATE INDEX idx_team_members_member ON team_members(tenant_id, member_name);

        -- messages
        CREATE TABLE messages_new (
          tenant_id TEXT NOT NULL,
          id TEXT NOT NULL,
          sender TEXT NOT NULL,
          recipient TEXT NOT NULL,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
          PRIMARY KEY (tenant_id, id),
          FOREIGN KEY (tenant_id, sender) REFERENCES participants(tenant_id, name)
        );
        INSERT INTO messages_new (tenant_id, id, sender, recipient, body, created_at)
        SELECT 'default', id, sender, recipient, body, created_at FROM messages;
        DROP TABLE messages;
        ALTER TABLE messages_new RENAME TO messages;
        CREATE INDEX idx_messages_recipient ON messages(tenant_id, recipient);
        CREATE INDEX idx_messages_sender ON messages(tenant_id, sender);
        CREATE INDEX idx_messages_created_at ON messages(tenant_id, created_at);

        -- read_receipts
        CREATE TABLE read_receipts_new (
          tenant_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          reader TEXT NOT NULL,
          read_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
          PRIMARY KEY (tenant_id, message_id, reader),
          FOREIGN KEY (tenant_id, message_id) REFERENCES messages(tenant_id, id),
          FOREIGN KEY (tenant_id, reader) REFERENCES participants(tenant_id, name)
        );
        INSERT INTO read_receipts_new (tenant_id, message_id, reader, read_at)
        SELECT 'default', message_id, reader, read_at FROM read_receipts;
        DROP TABLE read_receipts;
        ALTER TABLE read_receipts_new RENAME TO read_receipts;

        PRAGMA foreign_keys = ON;

        INSERT INTO schema_version (version, description)
        VALUES (6, 'multi-tenant: tenants table + tenant_id columns + composite PKs');
      `,
    });
  }

  // v6 → v7: participants に last_active_at 列を追加 (= productive activity timestamp、 issue #26)
  if (currentVersion < 7) {
    runMigration(db, {
      version: 7,
      description: 'add last_active_at column to participants for activity precision',
      sql: `
        ALTER TABLE participants ADD COLUMN last_active_at TEXT;
        INSERT INTO schema_version (version, description)
        VALUES (7, 'add last_active_at column to participants for activity precision');
      `,
    });
  }

  // v7 → v8: messages に sender_github_login 列を追加 (= PAT owner forensic audit、 issue #21 Fix 1)
  // NULL 許容: migration 前の既存 row のみ NULL。production server は PAT/trust 両 mode で non-null を書き込む。
  if (currentVersion < 8) {
    runMigration(db, {
      version: 8,
      description: 'add sender_github_login column to messages for forensic audit (issue #21 Fix 1)',
      sql: `
        ALTER TABLE messages ADD COLUMN sender_github_login TEXT;
        INSERT INTO schema_version (version, description)
        VALUES (8, 'add sender_github_login column to messages for forensic audit (issue #21 Fix 1)');
      `,
    });
  }

  // v8 → v9: messages.sender_github_login → sender_login rename (auth provider agnostic、 issue #127)
  if (currentVersion < 9) {
    runMigration(db, {
      version: 9,
      description: 'rename messages.sender_github_login to sender_login (issue #127)',
      sql: `
        ALTER TABLE messages RENAME COLUMN sender_github_login TO sender_login;
        INSERT INTO schema_version (version, description)
        VALUES (9, 'rename messages.sender_github_login to sender_login (issue #127)');
      `,
    });
  }

  // v9 → v10: message_causes junction テーブル追加（メッセージ因果チェーン追跡、issue #162）
  // V1: position=0 の成分のみ使用（単一 caused_by、Tree 構造）
  // V2: position > 0 を追加して DAG に拡張可能。このテーブルは再作成不要。
  if (currentVersion < 10) {
    runMigration(db, {
      version: 10,
      description: 'add message_causes junction table for causal chain tracking (issue #162)',
      sql: `
        CREATE TABLE message_causes (
          tenant_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          caused_by_id TEXT NOT NULL,
          position INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (tenant_id, message_id, caused_by_id),
          FOREIGN KEY (tenant_id, message_id) REFERENCES messages(tenant_id, id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, caused_by_id) REFERENCES messages(tenant_id, id)
        );
        CREATE INDEX idx_message_causes_caused_by ON message_causes(tenant_id, caused_by_id);
        INSERT INTO schema_version (version, description)
        VALUES (10, 'add message_causes junction table for causal chain tracking (issue #162)');
      `,
    });
  }

  // v10 → v11: message_causes に root_message_id カラム追加（O(1) スレッド検索、issue #166）
  // root_message_id = caused_by.root_message_id ?? caused_by (挿入時に計算して保存)
  // 既存 row のバックフィル: WITH RECURSIVE で因果チェーンを遡りルートを特定。
  // base case: caused_by_id が message_causes に存在しない → caused_by_id 自身がルート。
  // recursive case: 親の root_message_id を引き継ぐ。
  if (currentVersion < 11) {
    runMigration(db, {
      version: 11,
      description: 'add root_message_id to message_causes for O(1) thread search (issue #166)',
      sql: `
        ALTER TABLE message_causes ADD COLUMN root_message_id TEXT;
        CREATE INDEX idx_message_causes_root ON message_causes(tenant_id, root_message_id);
        WITH RECURSIVE resolved(tenant_id, message_id, root_message_id) AS (
          SELECT mc.tenant_id, mc.message_id, mc.caused_by_id
          FROM message_causes mc
          WHERE mc.position = 0
            AND NOT EXISTS (
              SELECT 1 FROM message_causes p
              WHERE p.tenant_id = mc.tenant_id
                AND p.message_id = mc.caused_by_id
                AND p.position = 0
            )
          UNION ALL
          SELECT mc.tenant_id, mc.message_id, r.root_message_id
          FROM message_causes mc
          JOIN resolved r
            ON r.tenant_id = mc.tenant_id
            AND r.message_id = mc.caused_by_id
          WHERE mc.position = 0
        )
        UPDATE message_causes
        SET root_message_id = (
          SELECT root_message_id FROM resolved
          WHERE resolved.tenant_id = message_causes.tenant_id
            AND resolved.message_id = message_causes.message_id
        )
        WHERE root_message_id IS NULL AND position = 0;
        INSERT INTO schema_version (version, description)
        VALUES (11, 'add root_message_id to message_causes for O(1) thread search (issue #166)');
      `,
    });
  }

  // v11 → v12: thread_status テーブル追加（dashboard スレッドステータス管理、issue #202）
  // dashboard が causal tree 上の各スレッドに done/stash/running を mark するテーブル。
  // hub の app.db に同居することで JOIN が自然にでき、docker volume の追加不要。
  // running / stale は read-time 計算のため DB に保存しない。
  if (currentVersion < 12) {
    runMigration(db, {
      version: 12,
      description: 'add thread_status table for dashboard thread status management (issue #202)',
      sql: `
        CREATE TABLE thread_status (
          root_message_id TEXT NOT NULL,
          tenant_id       TEXT NOT NULL DEFAULT 'default',
          status          TEXT NOT NULL,
          updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
          updated_by      TEXT,
          note            TEXT,
          PRIMARY KEY (root_message_id, tenant_id)
        );
        INSERT INTO schema_version (version, description)
        VALUES (12, 'add thread_status table for dashboard thread status management (issue #202)');
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

    // WAL モードでの synchronous 設定 (issue #168: in-flight transaction persistence)
    // NORMAL: コミット済みトランザクションは hub プロセスのクラッシュから保護される。
    //   WAL ファイルがディスクに残るため、次回起動時に SQLite が自動 replay する。
    //   WAL モードの推奨設定（FULL より高速）。
    // FULL:   OS クラッシュ・電源断からも保護（書き込みレイテンシが増加）。
    //   電源断保護が必要な環境では FULL に変更すること。
    db.pragma('synchronous = NORMAL');

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
