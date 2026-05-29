/**
 * schema v8 → v9 migration test (issue #127)
 * messages.sender_github_login → sender_login rename
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  applyMigrations,
  getCurrentVersion,
  runMigration,
} from '../migrations.js';

/**
 * v8 までの schema を fresh build する helper。
 * applyMigrations を v8 相当で止めるため、runMigration を直接使う。
 */
function buildV8Schema(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // v6 full DDL
  runMigration(db, {
    version: 6,
    description: 'v6 fresh build for v9 migration test',
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
}

describe('migration v8 → v9 (issue #127: messages.sender_github_login → sender_login)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('v8 DB に applyMigrations を適用すると v10 になり sender_login が存在し sender_github_login は消える', () => {
    buildV8Schema(db);
    expect(getCurrentVersion(db)).toBe(8);

    // v8 では sender_github_login が存在する
    const v8Columns = db
      .prepare(`PRAGMA table_info(messages)`)
      .all() as { name: string }[];
    expect(v8Columns.map((c) => c.name)).toContain('sender_github_login');
    expect(v8Columns.map((c) => c.name)).not.toContain('sender_login');

    // v9 → v10 migration 適用
    applyMigrations(db);
    expect(getCurrentVersion(db)).toBe(10);

    // sender_login に rename されている
    const v9Columns = db
      .prepare(`PRAGMA table_info(messages)`)
      .all() as { name: string; type: string }[];
    const col = v9Columns.find((c) => c.name === 'sender_login');
    expect(col).toBeDefined();
    expect(col!.type).toBe('TEXT');

    // sender_github_login は存在しない
    expect(v9Columns.map((c) => c.name)).not.toContain('sender_github_login');
  });

  it('v8 の既存 row が sender_github_login に持っていた値は v9 後も sender_login で参照できる', () => {
    buildV8Schema(db);

    // v8 DB に participants と message を insert (sender_github_login あり)
    db.prepare(`INSERT INTO participants (tenant_id, name) VALUES (?, ?)`).run('default', '@alice');
    db.prepare(`INSERT INTO participants (tenant_id, name) VALUES (?, ?)`).run('default', '@bob');
    const msgId = 'bbbbbbbb-0000-0000-0000-000000000002';
    db.prepare(
      `INSERT INTO messages (tenant_id, id, sender, recipient, body, sender_github_login) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('default', msgId, '@alice', '@bob', 'v8 message', 'kishibashi3');

    // migration 前の値確認
    const beforeRow = db
      .prepare(`SELECT sender_github_login FROM messages WHERE tenant_id = ? AND id = ?`)
      .get('default', msgId) as { sender_github_login: string | null };
    expect(beforeRow.sender_github_login).toBe('kishibashi3');

    // v9 → v10 migration 適用
    applyMigrations(db);
    expect(getCurrentVersion(db)).toBe(10);

    // rename 後も値が保持されている
    const afterRow = db
      .prepare(`SELECT sender_login FROM messages WHERE tenant_id = ? AND id = ?`)
      .get('default', msgId) as { sender_login: string | null };
    expect(afterRow.sender_login).toBe('kishibashi3');
  });

  it('v0 (= fresh install) では schema.sql から直接 v10 まで上がり sender_login column が存在する', () => {
    expect(getCurrentVersion(db)).toBe(0);

    applyMigrations(db);

    expect(getCurrentVersion(db)).toBe(10);

    const columns = db
      .prepare(`PRAGMA table_info(messages)`)
      .all() as { name: string }[];
    expect(columns.map((c) => c.name)).toContain('sender_login');
    expect(columns.map((c) => c.name)).not.toContain('sender_github_login');
  });

  it('v10 → v10 で no-op (= idempotent)', () => {
    applyMigrations(db);
    expect(getCurrentVersion(db)).toBe(10);

    // 再適用しても version は 10 のまま
    applyMigrations(db);
    expect(getCurrentVersion(db)).toBe(10);

    // schema_version table は v10 row が重複していない
    const rows = db
      .prepare(`SELECT version FROM schema_version WHERE version = ?`)
      .all(10) as { version: number }[];
    expect(rows).toHaveLength(1);
  });
});
