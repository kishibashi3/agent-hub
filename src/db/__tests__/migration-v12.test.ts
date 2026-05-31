/**
 * schema v11 → v12 migration test (issue #202)
 * dashboard_thread_status テーブル追加（dashboard スレッドステータス管理）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  applyMigrations,
  getCurrentVersion,
  runMigration,
} from '../migrations.js';

/**
 * v11 までの schema を fresh build する helper。
 */
function buildV11Schema(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // v6 full DDL
  runMigration(db, {
    version: 6,
    description: 'v6 fresh build for v12 migration test',
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

  // v7: last_active_at
  runMigration(db, {
    version: 7,
    description: 'add last_active_at column to participants for activity precision',
    sql: `
      ALTER TABLE participants ADD COLUMN last_active_at TEXT;
      INSERT INTO schema_version (version, description)
      VALUES (7, 'add last_active_at column to participants for activity precision');
    `,
  });

  // v8: sender_github_login
  runMigration(db, {
    version: 8,
    description: 'add sender_github_login column to messages for forensic audit (issue #21 Fix 1)',
    sql: `
      ALTER TABLE messages ADD COLUMN sender_github_login TEXT;
      INSERT INTO schema_version (version, description)
      VALUES (8, 'add sender_github_login column to messages for forensic audit (issue #21 Fix 1)');
    `,
  });

  // v9: rename sender_github_login → sender_login
  runMigration(db, {
    version: 9,
    description: 'rename messages.sender_github_login to sender_login (issue #127)',
    sql: `
      ALTER TABLE messages RENAME COLUMN sender_github_login TO sender_login;
      INSERT INTO schema_version (version, description)
      VALUES (9, 'rename messages.sender_github_login to sender_login (issue #127)');
    `,
  });

  // v10: message_causes
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

  // v11: root_message_id
  runMigration(db, {
    version: 11,
    description: 'add root_message_id to message_causes for O(1) thread search (issue #166)',
    sql: `
      ALTER TABLE message_causes ADD COLUMN root_message_id TEXT;
      CREATE INDEX idx_message_causes_root ON message_causes(tenant_id, root_message_id);
      INSERT INTO schema_version (version, description)
      VALUES (11, 'add root_message_id to message_causes for O(1) thread search (issue #166)');
    `,
  });
}

describe('migration v11 → v12 (issue #202: dashboard_thread_status table)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('v11 DB に applyMigrations を適用すると v12 になり dashboard_thread_status テーブルが存在する', () => {
    buildV11Schema(db);
    expect(getCurrentVersion(db)).toBe(11);

    // v11 では dashboard_thread_status テーブルが存在しない
    const v11Tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='dashboard_thread_status'`)
      .all() as { name: string }[];
    expect(v11Tables).toHaveLength(0);

    // v12 migration 適用
    applyMigrations(db);
    expect(getCurrentVersion(db)).toBe(12);

    // dashboard_thread_status テーブルが作成されている
    const v12Tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='dashboard_thread_status'`)
      .all() as { name: string }[];
    expect(v12Tables).toHaveLength(1);
  });

  it('dashboard_thread_status テーブルのカラム構成が正しい', () => {
    buildV11Schema(db);
    applyMigrations(db);

    const columns = db
      .prepare(`PRAGMA table_info(dashboard_thread_status)`)
      .all() as { name: string; type: string; notnull: number; pk: number }[];
    const colNames = columns.map((c) => c.name);

    expect(colNames).toContain('root_message_id');
    expect(colNames).toContain('tenant_id');
    expect(colNames).toContain('status');
    expect(colNames).toContain('updated_at');
    expect(colNames).toContain('updated_by');
    expect(colNames).toContain('note');

    // 複合 PK は (root_message_id, tenant_id)
    const pkCols = columns.filter((c) => c.pk > 0).map((c) => c.name);
    expect(pkCols).toContain('root_message_id');
    expect(pkCols).toContain('tenant_id');
  });

  it('dashboard_thread_status への UPSERT と SELECT が機能する', () => {
    buildV11Schema(db);
    applyMigrations(db);

    const rootId = 'test-root-0000-0000-0000-000000000001';

    // INSERT
    db.prepare(`
      INSERT INTO dashboard_thread_status (root_message_id, tenant_id, status, updated_at)
      VALUES (?, 'default', 'done', '2026-06-01T00:00:00.000Z')
    `).run(rootId);

    const row = db
      .prepare(`SELECT * FROM dashboard_thread_status WHERE root_message_id = ? AND tenant_id = 'default'`)
      .get(rootId) as { status: string; tenant_id: string } | undefined;
    expect(row?.status).toBe('done');

    // UPSERT (status 変更)
    db.prepare(`
      INSERT INTO dashboard_thread_status (root_message_id, tenant_id, status, updated_at)
      VALUES (?, 'default', 'stash', '2026-06-01T01:00:00.000Z')
      ON CONFLICT (root_message_id, tenant_id) DO UPDATE SET
        status     = excluded.status,
        updated_at = excluded.updated_at
    `).run(rootId);

    const row2 = db
      .prepare(`SELECT * FROM dashboard_thread_status WHERE root_message_id = ? AND tenant_id = 'default'`)
      .get(rootId) as { status: string } | undefined;
    expect(row2?.status).toBe('stash');
  });

  it('v0 (= fresh install) では schema.sql から直接 v12 まで上がり dashboard_thread_status が存在する', () => {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    expect(getCurrentVersion(db)).toBe(0);

    applyMigrations(db);
    expect(getCurrentVersion(db)).toBe(12);

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='dashboard_thread_status'`)
      .all() as { name: string }[];
    expect(tables).toHaveLength(1);
  });

  it('v12 → v12 で no-op (= idempotent)、v12 row は重複しない', () => {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    applyMigrations(db);
    expect(getCurrentVersion(db)).toBe(12);

    applyMigrations(db);
    expect(getCurrentVersion(db)).toBe(12);

    const rows = db
      .prepare(`SELECT version FROM schema_version WHERE version = ?`)
      .all(12) as { version: number }[];
    expect(rows).toHaveLength(1);
  });
});
