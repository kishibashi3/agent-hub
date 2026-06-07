/**
 * schema v11 → v12 migration test (issue #259)
 * timestamp format を RFC 3339 / ISO 8601+Z に統一。
 * 特に NULL created_at を持つレコードが NOT NULL 制約違反を起こさないことを確認 (PR #260 hotfix)。
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
    description: 'add last_active_at column to participants',
    sql: `
      ALTER TABLE participants ADD COLUMN last_active_at TEXT;
      INSERT INTO schema_version (version, description)
      VALUES (7, 'add last_active_at column to participants');
    `,
  });

  // v8: sender_github_login を messages に追加
  runMigration(db, {
    version: 8,
    description: 'add sender_github_login column to messages',
    sql: `
      ALTER TABLE messages ADD COLUMN sender_github_login TEXT;
      INSERT INTO schema_version (version, description)
      VALUES (8, 'add sender_github_login column to messages');
    `,
  });

  // v9: sender_github_login → sender_login rename
  runMigration(db, {
    version: 9,
    description: 'rename messages.sender_github_login to sender_login',
    sql: `
      ALTER TABLE messages RENAME COLUMN sender_github_login TO sender_login;
      INSERT INTO schema_version (version, description)
      VALUES (9, 'rename messages.sender_github_login to sender_login');
    `,
  });

  // v10: message_causes junction テーブル追加
  runMigration(db, {
    version: 10,
    description: 'add message_causes junction table',
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
      VALUES (10, 'add message_causes junction table');
    `,
  });

  // v11: message_causes.root_message_id 追加
  runMigration(db, {
    version: 11,
    description: 'add root_message_id to message_causes',
    sql: `
      ALTER TABLE message_causes ADD COLUMN root_message_id TEXT;
      CREATE INDEX idx_message_causes_root ON message_causes(tenant_id, root_message_id);
      INSERT INTO schema_version (version, description)
      VALUES (11, 'add root_message_id to message_causes');
    `,
  });
}

describe('migration v11 → v12 (issue #259: RFC 3339+Z timestamp unification)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('v11 DB (正常値: space-separated) に applyMigrations を適用すると v12 になる', () => {
    buildV11Schema(db);

    // space-separated の既存レコードを挿入 (外部キー制約を OFF にして直接 INSERT)
    db.pragma('foreign_keys = OFF');
    db.prepare(`INSERT INTO tenants (domain, created_at) VALUES (?, ?)`).run(
      'default',
      '2026-01-01 12:00:00.000'
    );
    db.prepare(
      `INSERT INTO participants (tenant_id, name, created_at) VALUES (?, ?, ?)`
    ).run('default', '@alice', '2026-01-01 12:00:00.000');
    db.pragma('foreign_keys = ON');

    expect(getCurrentVersion(db)).toBe(11);
    applyMigrations(db);
    expect(getCurrentVersion(db)).toBe(12);

    // RFC 3339+Z 形式に変換されている
    const tenant = db
      .prepare(`SELECT created_at FROM tenants WHERE domain = ?`)
      .get('default') as { created_at: string };
    expect(tenant.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);

    const participant = db
      .prepare(
        `SELECT created_at FROM participants WHERE tenant_id = ? AND name = ?`
      )
      .get('default', '@alice') as { created_at: string };
    expect(participant.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);
  });

  it('NULL created_at を持つレコードが migration v12 で NOT NULL 制約違反を起こさない (PR #260 hotfix)', () => {
    // NULL を直接挿入するために v6 スキーマを緩い制約で作る
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF');

    // NOT NULL 制約なしの v11 スキーマを模倣 (created_at を nullable で作成)
    runMigration(db, {
      version: 6,
      description: 'v6 with nullable created_at for NULL test',
      sql: `
        CREATE TABLE schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
          description TEXT NOT NULL
        );
        INSERT INTO schema_version (version, description) VALUES (6, 'v6 nullable fixture');

        CREATE TABLE tenants (
          domain TEXT PRIMARY KEY,
          owner TEXT,
          created_at TEXT
        );

        CREATE TABLE participants (
          tenant_id TEXT NOT NULL,
          name TEXT NOT NULL,
          display_name TEXT,
          owner TEXT,
          mode TEXT,
          deleted_at TEXT,
          last_active_at TEXT,
          created_at TEXT,
          PRIMARY KEY (tenant_id, name)
        );

        CREATE TABLE teams (
          tenant_id TEXT NOT NULL,
          name TEXT NOT NULL,
          owner TEXT NOT NULL,
          created_at TEXT,
          PRIMARY KEY (tenant_id, name)
        );

        CREATE TABLE team_members (
          tenant_id TEXT NOT NULL,
          team_name TEXT NOT NULL,
          member_name TEXT NOT NULL,
          joined_at TEXT,
          PRIMARY KEY (tenant_id, team_name, member_name)
        );
        CREATE INDEX idx_team_members_member ON team_members(tenant_id, member_name);

        CREATE TABLE messages (
          tenant_id TEXT NOT NULL,
          id TEXT NOT NULL,
          sender TEXT NOT NULL,
          recipient TEXT NOT NULL,
          body TEXT NOT NULL,
          sender_login TEXT,
          created_at TEXT,
          PRIMARY KEY (tenant_id, id)
        );
        CREATE INDEX idx_messages_recipient ON messages(tenant_id, recipient);
        CREATE INDEX idx_messages_sender ON messages(tenant_id, sender);
        CREATE INDEX idx_messages_created_at ON messages(tenant_id, created_at);

        CREATE TABLE read_receipts (
          tenant_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          reader TEXT NOT NULL,
          read_at TEXT,
          PRIMARY KEY (tenant_id, message_id, reader)
        );

        CREATE TABLE message_causes (
          tenant_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          caused_by_id TEXT NOT NULL,
          position INTEGER NOT NULL DEFAULT 0,
          root_message_id TEXT,
          PRIMARY KEY (tenant_id, message_id, caused_by_id)
        );
        CREATE INDEX idx_message_causes_caused_by ON message_causes(tenant_id, caused_by_id);
        CREATE INDEX idx_message_causes_root ON message_causes(tenant_id, root_message_id);
      `,
    });

    // v7〜v11 の schema_version エントリを追加 (migration 判定用)
    for (const v of [7, 8, 9, 10, 11]) {
      db.prepare(
        `INSERT INTO schema_version (version, description) VALUES (?, ?)`
      ).run(v, `v${v} fixture`);
    }

    // NULL created_at を持つレコードを挿入 (問題の再現)
    db.prepare(`INSERT INTO tenants (domain, created_at) VALUES (?, NULL)`).run(
      'default'
    );
    db.prepare(
      `INSERT INTO participants (tenant_id, name, created_at) VALUES (?, ?, NULL)`
    ).run('default', '@alice');
    db.prepare(
      `INSERT INTO teams (tenant_id, name, owner, created_at) VALUES (?, ?, ?, NULL)`
    ).run('default', 'dev', '@alice');
    db.prepare(
      `INSERT INTO team_members (tenant_id, team_name, member_name, joined_at) VALUES (?, ?, ?, NULL)`
    ).run('default', 'dev', '@alice');
    db.prepare(
      `INSERT INTO messages (tenant_id, id, sender, recipient, body, created_at) VALUES (?, ?, ?, ?, ?, NULL)`
    ).run('default', 'msg-001', '@alice', '@alice', 'hello');
    db.prepare(
      `INSERT INTO read_receipts (tenant_id, message_id, reader, read_at) VALUES (?, ?, ?, NULL)`
    ).run('default', 'msg-001', '@alice');

    expect(getCurrentVersion(db)).toBe(11);

    // v12 migration が例外なく完了することを確認 (NOT NULL 制約違反が出ないこと)
    expect(() => applyMigrations(db)).not.toThrow();
    expect(getCurrentVersion(db)).toBe(12);

    // 全レコードの created_at が RFC 3339+Z 形式になっている (NULL でない)
    const tenant = db
      .prepare(`SELECT created_at FROM tenants WHERE domain = ?`)
      .get('default') as { created_at: string };
    expect(tenant.created_at).not.toBeNull();
    expect(tenant.created_at).toMatch(/T.*Z$/);

    const participant = db
      .prepare(
        `SELECT created_at FROM participants WHERE tenant_id = ? AND name = ?`
      )
      .get('default', '@alice') as { created_at: string };
    expect(participant.created_at).not.toBeNull();
    expect(participant.created_at).toMatch(/T.*Z$/);

    const team = db
      .prepare(`SELECT created_at FROM teams WHERE tenant_id = ? AND name = ?`)
      .get('default', 'dev') as { created_at: string };
    expect(team.created_at).not.toBeNull();
    expect(team.created_at).toMatch(/T.*Z$/);

    const teamMember = db
      .prepare(
        `SELECT joined_at FROM team_members WHERE tenant_id = ? AND team_name = ? AND member_name = ?`
      )
      .get('default', 'dev', '@alice') as { joined_at: string };
    expect(teamMember.joined_at).not.toBeNull();
    expect(teamMember.joined_at).toMatch(/T.*Z$/);

    const message = db
      .prepare(
        `SELECT created_at FROM messages WHERE tenant_id = ? AND id = ?`
      )
      .get('default', 'msg-001') as { created_at: string };
    expect(message.created_at).not.toBeNull();
    expect(message.created_at).toMatch(/T.*Z$/);

    const readReceipt = db
      .prepare(
        `SELECT read_at FROM read_receipts WHERE tenant_id = ? AND message_id = ? AND reader = ?`
      )
      .get('default', 'msg-001', '@alice') as { read_at: string };
    expect(readReceipt.read_at).not.toBeNull();
    expect(readReceipt.read_at).toMatch(/T.*Z$/);
  });

  it('v0 (= fresh install) では schema.sql から直接 v12 まで上がる', () => {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    expect(getCurrentVersion(db)).toBe(0);

    applyMigrations(db);
    expect(getCurrentVersion(db)).toBe(12);
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

  it('FK 不整合データが存在しても migration v12 が成功する (PRAGMA foreign_keys = OFF が transaction 外で有効になることの確認)', () => {
    // 再現シナリオ: production DB に FK 不整合データ（sender が participants に存在しない
    // message など）があった場合、PRAGMA foreign_keys = OFF が no-op だと
    // migration の INSERT INTO messages_new SELECT ... FROM messages が
    // FK 制約違反で失敗する。
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF');

    // v11 スキーマを FK なしで作成（不整合データを挿入するため）
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
        description TEXT NOT NULL
      );
      CREATE TABLE tenants (
        domain TEXT PRIMARY KEY,
        owner TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
      );
      CREATE TABLE participants (
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        display_name TEXT,
        owner TEXT,
        mode TEXT,
        deleted_at TEXT,
        last_active_at TEXT,
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
        sender_login TEXT,
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
      CREATE TABLE message_causes (
        tenant_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        caused_by_id TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        root_message_id TEXT,
        PRIMARY KEY (tenant_id, message_id, caused_by_id),
        FOREIGN KEY (tenant_id, message_id) REFERENCES messages(tenant_id, id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, caused_by_id) REFERENCES messages(tenant_id, id)
      );
      CREATE INDEX idx_message_causes_caused_by ON message_causes(tenant_id, caused_by_id);
      CREATE INDEX idx_message_causes_root ON message_causes(tenant_id, root_message_id);
    `);
    // schema_version を v11 まで埋める
    for (const v of [6, 7, 8, 9, 10, 11]) {
      db.prepare(
        `INSERT INTO schema_version (version, description) VALUES (?, ?)`
      ).run(v, `v${v} fixture`);
    }

    // 正常データ
    db.prepare(`INSERT INTO tenants (domain) VALUES (?)`).run('default');
    db.prepare(
      `INSERT INTO participants (tenant_id, name) VALUES (?, ?)`
    ).run('default', '@alice');
    db.prepare(
      `INSERT INTO messages (tenant_id, id, sender, recipient, body) VALUES (?, ?, ?, ?, ?)`
    ).run('default', 'msg-root', '@alice', '@alice', 'root');
    db.prepare(
      `INSERT INTO messages (tenant_id, id, sender, recipient, body) VALUES (?, ?, ?, ?, ?)`
    ).run('default', 'msg-reply', '@alice', '@alice', 'reply');
    db.prepare(
      `INSERT INTO message_causes (tenant_id, message_id, caused_by_id, position, root_message_id) VALUES (?, ?, ?, ?, ?)`
    ).run('default', 'msg-reply', 'msg-root', 0, 'msg-root');
    db.prepare(
      `INSERT INTO read_receipts (tenant_id, message_id, reader) VALUES (?, ?, ?)`
    ).run('default', 'msg-root', '@alice');

    // FK 不整合データ: sender が participants に存在しない message
    // (過去の bug や直接 DB 操作で生じた孤立レコードを模倣)
    db.prepare(
      `INSERT INTO messages (tenant_id, id, sender, recipient, body) VALUES (?, ?, ?, ?, ?)`
    ).run('default', 'msg-orphan', '@deleted-bot', '@alice', 'orphan message');

    expect(getCurrentVersion(db)).toBe(11);

    // FK を ON に戻してから migration を実行（本番環境の initDatabase と同じ状態）
    db.pragma('foreign_keys = ON');

    // PRAGMA foreign_keys = OFF が transaction 外で有効になる修正により、
    // FK 不整合データがあっても migration が成功することを確認。
    // (修正前: INSERT INTO messages_new SELECT ... FROM messages で FK 制約違反が発生)
    expect(() => applyMigrations(db)).not.toThrow();
    expect(getCurrentVersion(db)).toBe(12);

    // message_causes データが保持されている
    const cause = db
      .prepare(
        `SELECT * FROM message_causes WHERE tenant_id = ? AND message_id = ?`
      )
      .get('default', 'msg-reply') as {
        message_id: string;
        caused_by_id: string;
        root_message_id: string;
      } | undefined;
    expect(cause).toBeDefined();
    expect(cause?.caused_by_id).toBe('msg-root');
    expect(cause?.root_message_id).toBe('msg-root');

    // FK 不整合レコード (msg-orphan) も保持されている（migration は既存データを壊さない）
    const orphan = db
      .prepare(`SELECT * FROM messages WHERE tenant_id = ? AND id = ?`)
      .get('default', 'msg-orphan') as { sender: string } | undefined;
    expect(orphan).toBeDefined();
    expect(orphan?.sender).toBe('@deleted-bot');
  });
});
