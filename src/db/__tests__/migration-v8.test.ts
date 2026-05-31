import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  applyMigrations,
  getCurrentVersion,
  runMigration,
} from '../migrations.js';
import { sendMessage } from '../messages.js';
import type { SendMessageInput } from '../../types/schema.js';

/**
 * issue #21 Fix 1 — schema v7 → v8 migration test
 *
 * v7 DB に v8 migration を単体適用したとき、
 * - `messages.sender_github_login` column が追加され
 * - 既存 row は sender_github_login = NULL で初期化され
 * - schema_version table に v8 が記録される
 * ことを verify する。
 *
 * 注: v9 以降は applyMigrations(db) を使うと sender_github_login → sender_login に rename される。
 * このファイルは v8 step の isolation test として runMigration 直呼びを使う。
 */
describe('migration v7 → v8 (issue #21 Fix 1: messages.sender_github_login)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  /**
   * v7 までの schema を fresh build する helper。
   * applyMigrations を v7 相当で止めるため、runMigration を直接使う。
   */
  function buildV7Schema(): void {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // v6 full DDL を flow
    runMigration(db, {
      version: 6,
      description: 'v6 fresh build for v8 migration test',
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
  }

  it('v7 → v8 migration (単体) で messages.sender_github_login column が追加される', () => {
    buildV7Schema();
    expect(getCurrentVersion(db)).toBe(7);

    // v7 では sender_github_login は存在しない
    const v7Columns = db
      .prepare(`PRAGMA table_info(messages)`)
      .all() as { name: string }[];
    expect(v7Columns.map((c) => c.name)).not.toContain('sender_github_login');

    // v7 のうちに既存 row を 1 件 insert (sender_github_login なし)
    db.prepare(
      `INSERT INTO participants (tenant_id, name) VALUES (?, ?)`
    ).run('default', '@alice');
    db.prepare(
      `INSERT INTO participants (tenant_id, name) VALUES (?, ?)`
    ).run('default', '@bob');
    const legacyMsgId = 'aaaaaaaa-0000-0000-0000-000000000001';
    db.prepare(
      `INSERT INTO messages (tenant_id, id, sender, recipient, body) VALUES (?, ?, ?, ?, ?)`
    ).run('default', legacyMsgId, '@alice', '@bob', 'legacy message');

    // v8 migration のみ単体適用 (applyMigrations は v9 まで走るため直呼び)
    runMigration(db, {
      version: 8,
      description: 'add sender_github_login column to messages for forensic audit (issue #21 Fix 1)',
      sql: `
        ALTER TABLE messages ADD COLUMN sender_github_login TEXT;
        INSERT INTO schema_version (version, description)
        VALUES (8, 'add sender_github_login column to messages for forensic audit (issue #21 Fix 1)');
      `,
    });
    expect(getCurrentVersion(db)).toBe(8);

    // sender_github_login column が増えている
    const v8Columns = db
      .prepare(`PRAGMA table_info(messages)`)
      .all() as { name: string; type: string }[];
    const col = v8Columns.find((c) => c.name === 'sender_github_login');
    expect(col).toBeDefined();
    expect(col!.type).toBe('TEXT');

    // 既存 row は NULL 初期化されている
    const row = db
      .prepare(
        `SELECT sender_github_login FROM messages WHERE tenant_id = ? AND id = ?`
      )
      .get('default', legacyMsgId) as { sender_github_login: string | null };
    expect(row.sender_github_login).toBeNull();
  });

  it('v0 (= fresh install) では schema.sql から直接 v10 まで上がり sender_login column が存在する', () => {
    expect(getCurrentVersion(db)).toBe(0);

    applyMigrations(db);

    expect(getCurrentVersion(db)).toBe(12);

    // sender_login column が schema.sql 由来で存在する (v9 名)
    const columns = db
      .prepare(`PRAGMA table_info(messages)`)
      .all() as { name: string }[];
    expect(columns.map((c) => c.name)).toContain('sender_login');
    expect(columns.map((c) => c.name)).not.toContain('sender_github_login');
  });

  it('v10 → v10 で no-op (= idempotent)', () => {
    applyMigrations(db);
    expect(getCurrentVersion(db)).toBe(12);

    // 再適用しても version は 10 のまま
    applyMigrations(db);
    expect(getCurrentVersion(db)).toBe(12);

    // schema_version table は v10 row が重複していない
    const rows = db
      .prepare(`SELECT version FROM schema_version WHERE version = ?`)
      .all(12) as { version: number }[];
    expect(rows).toHaveLength(1);
  });
});

// ============================================================
// send_message での sender_login 書き込み確認 (issue #127)
// ============================================================

describe('sendMessage sender_login write (issue #127)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyMigrations(db);
    db.pragma('foreign_keys = ON');

    // テスト参加者を登録
    db.prepare('INSERT INTO participants (tenant_id, name) VALUES (?, ?)').run(
      'default',
      '@alice'
    );
    db.prepare('INSERT INTO participants (tenant_id, name) VALUES (?, ?)').run(
      'default',
      '@bob'
    );
  });

  afterEach(() => {
    db.close();
  });

  it('PAT mode: senderLogin を渡すと messages.sender_login に記録される', () => {
    // PAT mode: login = 検証済み GitHub login (PAT owner)
    const input: SendMessageInput = { to: 'bob', message: 'PAT mode message' };
    const msg = sendMessage(db, 'default', input, 'alice', 'kishibashi3');

    const row = db
      .prepare('SELECT sender_login FROM messages WHERE tenant_id = ? AND id = ?')
      .get('default', msg.id) as { sender_login: string | null };

    expect(row.sender_login).toBe('kishibashi3');
  });

  it('trust mode: senderLogin = handle name (non-null) で記録される', () => {
    // trust mode (server.ts L443): login = handleName.slice(1) = handle の @ 除去形
    // → production server は trust mode でも non-null を書き込む
    const input: SendMessageInput = { to: 'bob', message: 'trust mode message' };
    const msg = sendMessage(db, 'default', input, 'alice', 'alice'); // senderLogin = handle name

    const row = db
      .prepare('SELECT sender_login FROM messages WHERE tenant_id = ? AND id = ?')
      .get('default', msg.id) as { sender_login: string | null };

    expect(row.sender_login).toBe('alice');
  });

  it('senderLogin 省略時は NULL になる (= 直接 API 呼び出し / migration 前 row 互換)', () => {
    // 注: production server は PAT/trust 両 mode で non-null を渡すため、
    // この NULL path は migration 前の既存 row と legacy direct-API 呼び出しのみ。
    const input: SendMessageInput = { to: 'bob', message: 'no senderLogin provided' };
    const msg = sendMessage(db, 'default', input, 'alice');

    const row = db
      .prepare('SELECT sender_login FROM messages WHERE tenant_id = ? AND id = ?')
      .get('default', msg.id) as { sender_login: string | null };

    expect(row.sender_login).toBeNull();
  });

  it('senderLogin = null を明示しても NULL になる', () => {
    const input: SendMessageInput = { to: 'bob', message: 'null explicit' };
    const msg = sendMessage(db, 'default', input, 'alice', null);

    const row = db
      .prepare('SELECT sender_login FROM messages WHERE tenant_id = ? AND id = ?')
      .get('default', msg.id) as { sender_login: string | null };

    expect(row.sender_login).toBeNull();
  });

  it('cross-persona override: override handle 送信者でも PAT owner が記録される', () => {
    // override パターン: PAT owner=kishibashi3 が @reviewer として送信
    db.prepare('INSERT INTO participants (tenant_id, name) VALUES (?, ?)').run(
      'default',
      '@reviewer'
    );

    const input: SendMessageInput = { to: 'alice', message: 'review comment' };
    // userId = '@reviewer' (override handle)、senderLogin = 'kishibashi3' (PAT owner)
    const msg = sendMessage(db, 'default', input, 'reviewer', 'kishibashi3');

    expect(msg.sender).toBe('@reviewer');

    const row = db
      .prepare('SELECT sender_login FROM messages WHERE tenant_id = ? AND id = ?')
      .get('default', msg.id) as { sender_login: string | null };

    // PAT owner が記録されている (= cross-persona override の forensic trail)
    expect(row.sender_login).toBe('kishibashi3');
  });

  it('Message 型は sender_login フィールドを含む', () => {
    const input: SendMessageInput = { to: 'bob', message: 'type check' };
    const msg = sendMessage(db, 'default', input, 'alice', 'kishibashi3');

    // Message 型として sender_login にアクセスできる
    expect(msg).toHaveProperty('sender_login');
    expect(msg.sender_login).toBe('kishibashi3');
  });
});
