-- agent-hub スキーマ v5
-- MCP Server 用。参加者・チーム・メッセージ・既読管理。
-- v3: participants に owner 列を追加（PAT 認証下のハンドル所有者を記録）
-- v4: participants に mode 列を追加（peer の worker type: stateful/stateless/global）
-- v5: participants に deleted_at 列を追加（soft delete、FK 制約と整合）

-- スキーマバージョン管理
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
  description TEXT NOT NULL
);

INSERT INTO schema_version (version, description)
VALUES (5, 'agent-hub: participants(+owner,+mode,+deleted_at), teams, messages, read_receipts');

-- 参加者（人間の代理エージェント含む）
-- register(name, display_name?, mode?) で登録される
-- owner は GitHub login（PAT 認証で得られる人間の identity）。
-- AGENT_HUB_USER による override 時、サーバーは owner == 認証 login を確認する。
-- NULL は v2 から移行した既存データ。最初に PAT で claim したユーザーが owner になる（TOFU）。
-- mode は peer の振る舞い宣言（stateful=peer 別文脈保持、stateless=単発、global=共有場）。
-- NULL は未宣言（後方互換）。詳細は agent-hub-bridge-adk リポジトリ README 参照。
CREATE TABLE participants (
  name TEXT PRIMARY KEY,           -- '@kishibashi' 形式。@ 付きで格納
  display_name TEXT,               -- 任意の表示名
  owner TEXT,                      -- GitHub login。NULL は未claimed
  mode TEXT,                       -- 'stateful' | 'stateless' | 'global' | NULL
  deleted_at TEXT,                 -- soft delete 時刻。NULL = active。FK 制約と整合させるための論理削除
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);

-- チーム
CREATE TABLE teams (
  name TEXT PRIMARY KEY,           -- '@project-x' 形式
  owner TEXT NOT NULL REFERENCES participants(name),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);

-- チームメンバー
CREATE TABLE team_members (
  team_name TEXT NOT NULL REFERENCES teams(name) ON DELETE CASCADE,
  member_name TEXT NOT NULL REFERENCES participants(name),
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
  PRIMARY KEY (team_name, member_name)
);

CREATE INDEX idx_team_members_member ON team_members(member_name);

-- メッセージ
-- DM: to = '@個人名', チーム: to = '@チーム名'
CREATE TABLE messages (
  id TEXT PRIMARY KEY,             -- UUID
  sender TEXT NOT NULL REFERENCES participants(name),
  recipient TEXT NOT NULL,         -- '@個人' or '@チーム'
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);

CREATE INDEX idx_messages_recipient ON messages(recipient);
CREATE INDEX idx_messages_sender ON messages(sender);
CREATE INDEX idx_messages_created_at ON messages(created_at);

-- 既読管理
-- メッセージ × 受信者 の組み合わせ
CREATE TABLE read_receipts (
  message_id TEXT NOT NULL REFERENCES messages(id),
  reader TEXT NOT NULL REFERENCES participants(name),
  read_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
  PRIMARY KEY (message_id, reader)
);
