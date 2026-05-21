import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  applyMigrations,
  getCurrentVersion,
  runMigration,
} from '../migrations.js';

/**
 * issue #26 - schema v6 → v7 migration test
 *
 * 既存 v6 DB に v7 migration を適用したとき、
 * - `participants.last_active_at` column が追加され
 * - 既存 row は last_active_at = NULL で初期化され
 * - schema_version table に v7 が記録される
 * ことを verify する。
 */
describe('migration v6 → v7 (issue #26: last_active_at)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  /**
   * v6 までの schema を fresh build する helper。
   * (= schema.sql ではなく、 migrations.ts の段階的 path を v6 まで実行)
   */
  function buildV6Schema(): void {
    // 直接 v6 までの DDL を流し込む。 v6 schema.sql の主要部分のみ。
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    runMigration(db, {
      version: 6,
      description: 'v6 fresh build for migration test',
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
  }

  it('v6 → v7 migration で participants.last_active_at column が追加される', () => {
    buildV6Schema();
    expect(getCurrentVersion(db)).toBe(6);

    // v6 では last_active_at は存在しない
    const v6Columns = db
      .prepare(`PRAGMA table_info(participants)`)
      .all() as { name: string }[];
    expect(v6Columns.map((c) => c.name)).not.toContain('last_active_at');

    // 既存 row を v6 のうちに 1 件 insert
    db.prepare(
      `INSERT INTO participants (tenant_id, name, display_name, owner)
       VALUES (?, ?, ?, ?)`
    ).run('default', '@legacy-alice', 'Legacy Alice', 'kishibashi');

    // migration 適用 (v6 → latest = v9)
    applyMigrations(db);
    expect(getCurrentVersion(db)).toBe(9);

    // last_active_at column が増えている
    const v7Columns = db
      .prepare(`PRAGMA table_info(participants)`)
      .all() as { name: string; type: string }[];
    const lastActive = v7Columns.find((c) => c.name === 'last_active_at');
    expect(lastActive).toBeDefined();
    expect(lastActive!.type).toBe('TEXT');

    // 既存 row は NULL 初期化されている
    const row = db
      .prepare(
        `SELECT last_active_at FROM participants WHERE tenant_id = ? AND name = ?`
      )
      .get('default', '@legacy-alice') as { last_active_at: string | null };
    expect(row.last_active_at).toBeNull();
  });

  it('v0 (= fresh install) では schema.sql から直接 v9 まで上がる (last_active_at も存在)', () => {
    expect(getCurrentVersion(db)).toBe(0);

    applyMigrations(db);

    expect(getCurrentVersion(db)).toBe(9);

    // last_active_at column が schema.sql 由来で存在する
    const columns = db
      .prepare(`PRAGMA table_info(participants)`)
      .all() as { name: string }[];
    expect(columns.map((c) => c.name)).toContain('last_active_at');
  });

  it('v9 → v9 で no-op (= idempotent)、v9 row は重複しない', () => {
    applyMigrations(db);
    expect(getCurrentVersion(db)).toBe(9);

    // 再適用しても version は 9 のまま
    applyMigrations(db);
    expect(getCurrentVersion(db)).toBe(9);

    // schema_version table は v9 row が重複していない
    const rows = db
      .prepare(`SELECT version FROM schema_version WHERE version = ?`)
      .all(9) as { version: number }[];
    expect(rows).toHaveLength(1);
  });
});
