/**
 * schema v9 → v10 migration test (issue #162)
 * message_causes junction テーブル追加（メッセージ因果チェーン追跡）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  applyMigrations,
  getCurrentVersion,
  runMigration,
} from '../migrations.js';

/**
 * v9 までの schema を fresh build する helper。
 * applyMigrations を v9 相当で止めるため、runMigration を直接使う。
 */
function buildV9Schema(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // v6 full DDL
  runMigration(db, {
    version: 6,
    description: 'v6 fresh build for v10 migration test',
    sql: `
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
        description TEXT NOT NULL
      );
      INSERT INTO schema_version (version, description) VALUES (6, 'v6 fixture');

      CREATE TABLE tenants (
        domain TEXT PRIMARY KEY,
        owner TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
      );
      INSERT INTO tenants (domain, owner) VALUES ('default', NULL);

      CREATE TABLE participants (
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        display_name TEXT,
        owner TEXT,
        mode TEXT,
        deleted_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
        PRIMARY KEY (tenant_id, name)
      );

      CREATE TABLE teams (
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        owner TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
        PRIMARY KEY (tenant_id, name),
        FOREIGN KEY (tenant_id, owner) REFERENCES participants(tenant_id, name)
      );

      CREATE TABLE team_members (
        tenant_id TEXT NOT NULL,
        team_name TEXT NOT NULL,
        member_name TEXT NOT NULL,
        joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
        PRIMARY KEY (tenant_id, team_name, member_name),
        FOREIGN KEY (tenant_id, team_name) REFERENCES teams(tenant_id, name) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, member_name) REFERENCES participants(tenant_id, name)
      );
      CREATE INDEX idx_team_members_member ON team_members(tenant_id, member_name);

      CREATE TABLE messages (
        tenant_id TEXT NOT NULL,
        id TEXT NOT NULL,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
        PRIMARY KEY (tenant_id, id),
        FOREIGN KEY (tenant_id, sender) REFERENCES participants(tenant_id, name)
      );
      CREATE INDEX idx_messages_recipient ON messages(tenant_id, recipient);
      CREATE INDEX idx_messages_sender ON messages(tenant_id, sender);
      CREATE INDEX idx_messages_created_at ON messages(tenant_id, created_at);

      CREATE TABLE read_receipts (
        tenant_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        reader TEXT NOT NULL,
        read_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
        PRIMARY KEY (tenant_id, message_id, reader),
        FOREIGN KEY (tenant_id, message_id) REFERENCES messages(tenant_id, id),
        FOREIGN KEY (tenant_id, reader) REFERENCES participants(tenant_id, name)
      );
    `,
  });

  // v7: last_active_at を participants に追加
  runMigration(db, {
    version: 7,
    description: 'add last_active_at column to participants for activity precision',
    sql: `
      ALTER TABLE participants ADD COLUMN last_active_at TEXT;
      INSERT INTO schema_version (version, description)
      VALUES (7, 'add last_active_at column to participants for activity precision');
    `,
  });

  // v8: sender_github_login を messages に追加
  runMigration(db, {
    version: 8,
    description: 'add sender_github_login column to messages for forensic audit (issue #21 Fix 1)',
    sql: `
      ALTER TABLE messages ADD COLUMN sender_github_login TEXT;
      INSERT INTO schema_version (version, description)
      VALUES (8, 'add sender_github_login column to messages for forensic audit (issue #21 Fix 1)');
    `,
  });

  // v9: sender_github_login → sender_login rename
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

describe('migration v9 → v10 (issue #162: message_causes junction テーブル)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('v9 DB に applyMigrations を適用すると v10 になり message_causes テーブルが存在する', () => {
    buildV9Schema(db);
    expect(getCurrentVersion(db)).toBe(9);

    // v9 では message_causes テーブルが存在しない
    const v9Tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all() as { name: string }[];
    expect(v9Tables.map((t) => t.name)).not.toContain('message_causes');

    // v10 migration 適用
    applyMigrations(db);
    expect(getCurrentVersion(db)).toBe(11);

    // message_causes テーブルが作成されている
    const v10Tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all() as { name: string }[];
    expect(v10Tables.map((t) => t.name)).toContain('message_causes');

    // インデックスも作成されている
    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_message_causes%'`)
      .all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toContain('idx_message_causes_caused_by');
  });

  it('v9 → v10 後に message_causes テーブルに正しいカラムが存在する', () => {
    buildV9Schema(db);
    applyMigrations(db);

    const columns = db
      .prepare(`PRAGMA table_info(message_causes)`)
      .all() as { name: string; type: string; notnull: number }[];
    const colNames = columns.map((c) => c.name);

    expect(colNames).toContain('tenant_id');
    expect(colNames).toContain('message_id');
    expect(colNames).toContain('caused_by_id');
    expect(colNames).toContain('position');

    // position のデフォルト値が 0
    const posCol = columns.find((c) => c.name === 'position');
    expect(posCol?.notnull).toBe(1); // NOT NULL
  });

  it('v0 (= fresh install) では schema.sql から直接 v10 まで上がり message_causes が存在する', () => {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    expect(getCurrentVersion(db)).toBe(0);

    applyMigrations(db);
    expect(getCurrentVersion(db)).toBe(11);

    // message_causes テーブルが schema.sql 由来で存在する
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain('message_causes');
  });

  it('v10 → v10 で no-op (= idempotent)、v10 row は重複しない', () => {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    applyMigrations(db);
    expect(getCurrentVersion(db)).toBe(11);

    // 再適用しても version は 10 のまま
    applyMigrations(db);
    expect(getCurrentVersion(db)).toBe(11);

    // schema_version table は v10 row が重複していない
    const rows = db
      .prepare(`SELECT version FROM schema_version WHERE version = ?`)
      .all(11) as { version: number }[];
    expect(rows).toHaveLength(1);
  });
});
