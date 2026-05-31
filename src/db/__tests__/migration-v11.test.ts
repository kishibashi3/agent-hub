/**
 * schema v10 → v11 migration test (issue #166)
 * message_causes に root_message_id カラム追加（O(1) スレッド検索）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  applyMigrations,
  getCurrentVersion,
  runMigration,
} from '../migrations.js';

/**
 * v10 までの schema を fresh build する helper。
 * applyMigrations を v10 相当で止めるため、runMigration を直接使う。
 */
function buildV10Schema(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // v6 full DDL
  runMigration(db, {
    version: 6,
    description: 'v6 fresh build for v11 migration test',
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

  // v10: message_causes junction テーブル追加 (issue #162)
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

describe('migration v10 → v11 (issue #166: message_causes.root_message_id)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('v10 DB に applyMigrations を適用すると v11 になり root_message_id カラムが存在する', () => {
    buildV10Schema(db);
    expect(getCurrentVersion(db)).toBe(10);

    // v10 では root_message_id カラムが存在しない
    const v10Columns = db
      .prepare(`PRAGMA table_info(message_causes)`)
      .all() as { name: string }[];
    expect(v10Columns.map((c) => c.name)).not.toContain('root_message_id');

    // v11 migration 適用
    applyMigrations(db);
    expect(getCurrentVersion(db)).toBe(11);

    // root_message_id カラムが追加されている
    const v11Columns = db
      .prepare(`PRAGMA table_info(message_causes)`)
      .all() as { name: string }[];
    expect(v11Columns.map((c) => c.name)).toContain('root_message_id');

    // idx_message_causes_root インデックスが作成されている
    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_message_causes%'`)
      .all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toContain('idx_message_causes_root');
  });

  it('v10 の既存 message_causes rows が migration 後に root_message_id をバックフィルされる', () => {
    buildV10Schema(db);

    // v10 DB にテストデータを挿入 (root → reply1 → reply2 の 2 hop チェーン)
    db.prepare(`INSERT INTO participants (tenant_id, name) VALUES (?, ?)`).run('default', '@alice');
    db.prepare(`INSERT INTO participants (tenant_id, name) VALUES (?, ?)`).run('default', '@bob');
    const rootId = 'root-0000-0000-0000-000000000001';
    const reply1Id = 'rpl1-0000-0000-0000-000000000002';
    const reply2Id = 'rpl2-0000-0000-0000-000000000003';

    db.prepare(
      `INSERT INTO messages (tenant_id, id, sender, recipient, body) VALUES (?, ?, ?, ?, ?)`
    ).run('default', rootId, '@alice', '@bob', 'root');
    db.prepare(
      `INSERT INTO messages (tenant_id, id, sender, recipient, body) VALUES (?, ?, ?, ?, ?)`
    ).run('default', reply1Id, '@bob', '@alice', 'reply1');
    db.prepare(
      `INSERT INTO messages (tenant_id, id, sender, recipient, body) VALUES (?, ?, ?, ?, ?)`
    ).run('default', reply2Id, '@alice', '@bob', 'reply2');

    // v10 形式 (root_message_id なし) で message_causes を挿入
    db.prepare(
      `INSERT INTO message_causes (tenant_id, message_id, caused_by_id, position) VALUES (?, ?, ?, 0)`
    ).run('default', reply1Id, rootId);
    db.prepare(
      `INSERT INTO message_causes (tenant_id, message_id, caused_by_id, position) VALUES (?, ?, ?, 0)`
    ).run('default', reply2Id, reply1Id);

    // v11 migration 適用
    applyMigrations(db);
    expect(getCurrentVersion(db)).toBe(11);

    // reply1 の root_message_id = rootId (直接の親がルート)
    const r1 = db
      .prepare(`SELECT root_message_id FROM message_causes WHERE tenant_id = ? AND message_id = ?`)
      .get('default', reply1Id) as { root_message_id: string | null };
    expect(r1.root_message_id).toBe(rootId);

    // reply2 の root_message_id = rootId (2 hop: reply2 → reply1 → root)
    const r2 = db
      .prepare(`SELECT root_message_id FROM message_causes WHERE tenant_id = ? AND message_id = ?`)
      .get('default', reply2Id) as { root_message_id: string | null };
    expect(r2.root_message_id).toBe(rootId);
  });

  it('v0 (= fresh install) では schema.sql から直接 v12 まで上がり root_message_id が存在する', () => {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    expect(getCurrentVersion(db)).toBe(0);

    applyMigrations(db);
    expect(getCurrentVersion(db)).toBe(11);

    // message_causes テーブルに root_message_id カラムが存在する
    const columns = db
      .prepare(`PRAGMA table_info(message_causes)`)
      .all() as { name: string }[];
    expect(columns.map((c) => c.name)).toContain('root_message_id');
  });

  it('v12 → v12 で no-op (= idempotent)、v11 row は重複しない', () => {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    applyMigrations(db);
    expect(getCurrentVersion(db)).toBe(11);

    // 再適用しても version は 12 のまま
    applyMigrations(db);
    expect(getCurrentVersion(db)).toBe(11);

    // schema_version table は v11 row が重複していない
    const rows = db
      .prepare(`SELECT version FROM schema_version WHERE version = ?`)
      .all(11) as { version: number }[];
    expect(rows).toHaveLength(1);
  });
});
