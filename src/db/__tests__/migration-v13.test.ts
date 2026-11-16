/**
 * schema v12 → v13 migration test (issue #348)
 * read_receipts に acted_by カラム追加（代理 flush の監査記録）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  applyMigrations,
  getCurrentVersion,
  runMigration,
  migrateToV13,
  CURRENT_SCHEMA_VERSION,
} from '../migrations.js';

/**
 * v12 相当の schema を fresh build する helper (issue #348 の対象テーブルのみ)。
 * v12 rebuild 後の最終形 (tenants/participants/messages/read_receipts) を直接作る
 * (migrateToV13 は read_receipts への ALTER TABLE ADD COLUMN のみなので、
 * v6→v12 の全段階を再現する必要はない)。
 */
function buildV12Schema(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigration(db, {
    version: 12,
    description: 'v12 fresh build for v13 migration test',
    sql: `
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        description TEXT NOT NULL
      );
      INSERT INTO schema_version (version, description) VALUES (12, 'v12 fixture');

      CREATE TABLE tenants (
        domain TEXT PRIMARY KEY,
        owner TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      INSERT INTO tenants (domain, owner) VALUES ('default', NULL);

      CREATE TABLE participants (
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        display_name TEXT,
        owner TEXT,
        mode TEXT,
        deleted_at TEXT,
        last_active_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY (tenant_id, name)
      );

      CREATE TABLE messages (
        tenant_id TEXT NOT NULL,
        id TEXT NOT NULL,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        body TEXT NOT NULL,
        sender_login TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
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
        read_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY (tenant_id, message_id, reader),
        FOREIGN KEY (tenant_id, message_id) REFERENCES messages(tenant_id, id),
        FOREIGN KEY (tenant_id, reader) REFERENCES participants(tenant_id, name)
      );
    `,
  });
}

describe('migration v12 → v13 (issue #348: read_receipts.acted_by)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('v12 DB に v13 migration を単体適用すると acted_by カラムが存在する', () => {
    buildV12Schema(db);
    expect(getCurrentVersion(db)).toBe(12);

    // v12 では acted_by が存在しない
    const v12Columns = db
      .prepare(`PRAGMA table_info(read_receipts)`)
      .all() as { name: string }[];
    expect(v12Columns.map((c) => c.name)).not.toContain('acted_by');

    // v13 migration のみ単体適用 (= 後続バージョンを巻き込まない diff test)
    migrateToV13(db);
    expect(getCurrentVersion(db)).toBe(13);

    const v13Columns = db
      .prepare(`PRAGMA table_info(read_receipts)`)
      .all() as { name: string }[];
    expect(v13Columns.map((c) => c.name)).toContain('acted_by');
  });

  it('v12 の既存 read_receipts row は migration 後 acted_by が NULL のまま (遡及 backfill しない)', () => {
    buildV12Schema(db);

    db.prepare(`INSERT INTO participants (tenant_id, name) VALUES (?, ?)`).run('default', '@alice');
    db.prepare(`INSERT INTO participants (tenant_id, name) VALUES (?, ?)`).run('default', '@bob');
    const msgId = 'aaaaaaaa-0000-0000-0000-000000000001';
    db.prepare(
      `INSERT INTO messages (tenant_id, id, sender, recipient, body) VALUES (?, ?, ?, ?, ?)`
    ).run('default', msgId, '@alice', '@bob', 'v12 message');
    db.prepare(
      `INSERT INTO read_receipts (tenant_id, message_id, reader) VALUES (?, ?, ?)`
    ).run('default', msgId, '@bob');

    migrateToV13(db);
    expect(getCurrentVersion(db)).toBe(13);

    const row = db
      .prepare(`SELECT acted_by FROM read_receipts WHERE tenant_id = ? AND message_id = ? AND reader = ?`)
      .get('default', msgId, '@bob') as { acted_by: string | null };
    expect(row.acted_by).toBeNull();
  });

  it('v0 (= fresh install) では schema.sql から直接最新まで上がり acted_by カラムが存在する', () => {
    expect(getCurrentVersion(db)).toBe(0);

    applyMigrations(db);
    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);

    const columns = db
      .prepare(`PRAGMA table_info(read_receipts)`)
      .all() as { name: string }[];
    expect(columns.map((c) => c.name)).toContain('acted_by');
  });

  it('latest → latest で no-op (= idempotent)', () => {
    applyMigrations(db);
    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);

    applyMigrations(db);
    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);

    const rows = db
      .prepare(`SELECT version FROM schema_version WHERE version = ?`)
      .all(CURRENT_SCHEMA_VERSION) as { version: number }[];
    expect(rows).toHaveLength(1);
  });
});
