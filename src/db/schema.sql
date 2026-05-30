-- agent-hub スキーマ v10
-- MCP Server 用。参加者・チーム・メッセージ・既読管理 (multi-tenant)。
-- v3: participants に owner 列を追加（PAT 認証下のハンドル所有者を記録）
-- v4: participants に mode 列を追加（peer の worker type: stateful/stateless/global）
-- v5: participants に deleted_at 列を追加（soft delete、FK 制約と整合）
-- v6: multi-tenant 対応 (Community Edition)
--      - tenants テーブル新設 (domain → owner GitHub login、NULL = open lobby)
--      - 全テーブルに tenant_id 列追加、PK を (tenant_id, ...) 複合主キー化
--      - 別 tenant の @alice 同士が衝突しない
--      - default tenant (= 雑談室、X-Tenant-Id 未指定) を pre-create
-- v7: participants に last_active_at 列を追加（productive activity timestamp）
--      - send_message / get_messages / mark_as_read / register / get_history で update
--      - is_online (subscribe flag) と組み合わせて idle vs active を区別
-- v8: messages に sender_github_login 列を追加（PAT owner の forensic audit、issue #21 Fix 1）
--      - NULL 許容: migration 前の既存 row のみ NULL (production server は PAT/trust 両 mode で non-null を書き込む)
-- v9: messages.sender_github_login → sender_login rename (auth provider agnostic, issue #127)
-- v10: message_causes junction テーブル追加（メッセージ因果チェーン追跡、issue #162）
--      - V1: position=0 の成分のみ使用（単一 caused_by、Tree 構造）
--      - V2: position > 0 で DAG（複数親）に拡張可能。migration 不要。
-- v11: message_causes に root_message_id カラム追加（O(1) スレッド検索、issue #166）
--      - 挿入時に caused_by.root_message_id ?? caused_by で計算して保存。WITH RECURSIVE 不要。

-- スキーマバージョン管理
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
  description TEXT NOT NULL
);

INSERT INTO schema_version (version, description)
VALUES (11, 'agent-hub v11: add root_message_id to message_causes for O(1) thread search (issue #166)');

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
  last_active_at TEXT,             -- v7: productive activity timestamp (= 5 tool 経由で update)。NULL = 未活動 / v7 以前 register
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
  sender_login TEXT,               -- v8/v9: auth login (PAT owner 等、forensic audit)。NULL = migration 前の既存 row のみ
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, sender) REFERENCES participants(tenant_id, name)
);

CREATE INDEX idx_messages_recipient ON messages(tenant_id, recipient);
CREATE INDEX idx_messages_sender ON messages(tenant_id, sender);
CREATE INDEX idx_messages_created_at ON messages(tenant_id, created_at);

-- メッセージ因果テーブル (issue #162)
-- DM / チーム broadcast 間のリクエスト伝播経路を記録する。
-- V1: position=0 の成分のみ使用（send_message の caused_by 引数 = 直接の親）
-- V2: position > 0 を追加することで DAG（複数親）に拡張可能。テーブル再作成不要。
-- FK: ON DELETE CASCADE で親 message 削除時に自動削除。caused_by_id は no action（orphan を許容）。
CREATE TABLE message_causes (
  tenant_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  caused_by_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,  -- 0 = primary（主因果）/ 将来 DAG 対応で 1,2,... を追加
  root_message_id TEXT NOT NULL,         -- スレッドルート messages.id (O(1) スレッド検索用、issue #166)
  PRIMARY KEY (tenant_id, message_id, caused_by_id),
  FOREIGN KEY (tenant_id, message_id) REFERENCES messages(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, caused_by_id) REFERENCES messages(tenant_id, id),
  FOREIGN KEY (tenant_id, root_message_id) REFERENCES messages(tenant_id, id)
);

-- caused_by_id で「このメッセージを原因とする子メッセージ」を高速検索するためのインデックス
CREATE INDEX idx_message_causes_caused_by ON message_causes(tenant_id, caused_by_id);
-- root_message_id でスレッド内全メッセージを O(1) で検索するためのインデックス
CREATE INDEX idx_message_causes_root ON message_causes(tenant_id, root_message_id);

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
