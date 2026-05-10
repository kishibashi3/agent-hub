-- agent-hub スキーマ v6
-- MCP Server 用。参加者・チーム・メッセージ・既読管理 (multi-tenant)。
-- v3: participants に owner 列を追加（PAT 認証下のハンドル所有者を記録）
-- v4: participants に mode 列を追加（peer の worker type: stateful/stateless/global）
-- v5: participants に deleted_at 列を追加（soft delete、FK 制約と整合）
-- v6: multi-tenant 対応 (Community Edition)
--      - tenants テーブル新設 (domain → owner GitHub login、NULL = open lobby)
--      - 全テーブルに tenant_id 列追加、PK を (tenant_id, ...) 複合主キー化
--      - 別 tenant の @alice 同士が衝突しない
--      - default tenant (= 雑談室、X-Tenant-Id 未指定) を pre-create

-- スキーマバージョン管理
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
  description TEXT NOT NULL
);

INSERT INTO schema_version (version, description)
VALUES (6, 'agent-hub v6: multi-tenant (tenants table, tenant_id columns, composite PKs)');

-- tenant 登録テーブル
-- domain は X-Tenant-Id header の値。
-- owner NULL = 雑談室 (default tenant、open lobby、誰でも register / 発言可)。
-- owner NOT NULL = 個人 private hub の TOFU claim 主 (= GitHub login)。
CREATE TABLE tenants (
  domain TEXT PRIMARY KEY,
  owner TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);

-- 雑談室を pre-create
INSERT INTO tenants (domain, owner) VALUES ('default', NULL);

-- 参加者
-- name は tenant 内で unique。別 tenant の @alice とは別エンティティ。
CREATE TABLE participants (
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,              -- '@kishibashi' 形式
  display_name TEXT,
  owner TEXT,                      -- GitHub login。NULL は未claimed (v2 移行時の互換)
  mode TEXT,                       -- 'stateful' | 'stateless' | 'global' | NULL
  deleted_at TEXT,                 -- soft delete 時刻。NULL = active
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
  PRIMARY KEY (tenant_id, name)
);

-- チーム
CREATE TABLE teams (
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,              -- '@project-x' 形式
  owner TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
  PRIMARY KEY (tenant_id, name),
  FOREIGN KEY (tenant_id, owner) REFERENCES participants(tenant_id, name)
);

-- チームメンバー
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

-- メッセージ
-- DM: recipient = '@個人名', チーム: recipient = '@チーム名'
CREATE TABLE messages (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,                -- UUID
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

-- 既読管理
CREATE TABLE read_receipts (
  tenant_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  reader TEXT NOT NULL,
  read_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
  PRIMARY KEY (tenant_id, message_id, reader),
  FOREIGN KEY (tenant_id, message_id) REFERENCES messages(tenant_id, id),
  FOREIGN KEY (tenant_id, reader) REFERENCES participants(tenant_id, name)
);
