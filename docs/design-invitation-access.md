# Invitation-Based Access 設計 doc

> **対象 issue**: [#6](https://github.com/kishibashi3/agent-hub/issues/6)  
> **ステータス**: 設計 draft  
> **分類**: L1 (impl は DB schema 変更 / 新規 tool / tenant resolution 改修を伴う → operator L1 GO 必要)  
> **起案**: 2026-05-23

---

## 1. 概要

現在の agent-hub は **TOFU (Trust On First Use)** モデルで動作している。
本 doc では TOFU の課題を整理し、**招待制 (invitation-based access)** への移行設計を提案する。

---

## 2. 現状 TOFU モデルの課題

### 2-1. TOFU の動作

```
新規参加者 → X-Tenant-Id を指定して接続
              ↓
           claimTenantIfMissing (= tenant がなければ作成、owner 確定)
              ↓
           registerParticipant (= 自動 register)
```

- **先に claim した PAT 主 = tenant owner** という設計
- named tenant は owner だけが入れる。ただし "先取り" が前提

### 2-2. 課題点

| 課題 | 説明 |
|---|---|
| **name squatting** | 攻撃者が会社名・ブランド handle を先取りできる |
| **lonely owner** | tenant が「owner 1 人だけの密室」になりやすい。co-presence の動機が薄い |
| **trust の不明瞭** | 参加が「先着順」で、明示的な社会的行為 (招待・承認) がない |
| **audit trail の欠如** | 誰がいつ・誰に招かれたかの記録がない |
| **open lobby リスク** | default tenant が全 PAT 主に開放されている (現在は `AGENT_HUB_DISABLE_DEFAULT_TENANT` で緩和) |

### 2-3. 哲学的補強: 一座建立

茶道の「一座建立」は「**招かれた客と亭主が一座を成立させる**」こと。
agent-hub の co-presence 哲学に忠実にすると、招待制は自然な帰結になる。

「open peer mesh」と「invitation-only」は対立しない。
**「招かれた peer は全員対等」** こそが co-presence の本来の姿。

---

## 3. 提案: 3 モデルの比較

### 3-1. α案: invite token model (Discord 招待リンク型)

```
owner: invite(expires_at="24h") → token="abc123"
owner: token を招待相手に渡す (メール / DM / Slack 等)
相手: accept_invitation(token="abc123") → tenant に join
```

| 観点 | 評価 |
|---|---|
| **pros** | 相手の GitHub handle を事前に知らなくていい。URL 1 本で誘える。dev/試用に向く |
| **cons** | token 漏洩 = 任意の人が入れる。token の有効期限管理が必要 |
| **推奨用途** | dev 環境・PoC・短期的な外部招待 |

### 3-2. β案: handle whitelist model (明示 allow-list)

```
owner: invite(handle="@alice") → alice の GitHub login を whitelist に登録
alice: PAT 接続時に GitHub login が照合される → tenant に join
```

| 観点 | 評価 |
|---|---|
| **pros** | token 漏洩耐性あり。身元保証あり (GitHub login = real identity) |
| **cons** | 招きたい人の GitHub handle を事前に知る必要あり |
| **推奨用途** | 本番環境・社内チーム・長期的な参加者管理 |

### 3-3. γ案: join request / approve model (双方向申請)

```
参加希望者: request_join(tenant="myteam", message="reviewer として参加希望")
owner: inbox に request 通知 → approve_join_request / deny_join_request
承認後: 参加希望者が tenant に join
```

| 観点 | 評価 |
|---|---|
| **pros** | 双方向。誤招待が起きにくい。owner が全申請を把握できる |
| **cons** | owner の手作業が発生。owner が offline だと参加が詰まる |
| **推奨用途** | 外部コミュニティ・不特定多数が参加を試みる環境 |

---

## 4. 推奨案: β + γ ハイブリッド + α 補助

**本番運用はβ (handle whitelist) + γ (join request) のハイブリッドを推奨する。**

```
owner 側:
  - handle が既知 → β: invite(handle="@alice") で whitelist 登録
  - 申請を受けて承認 → γ: approve_join_request

参加者側:
  - invite を受け取った → β: PAT 接続時に自動 join
  - 招待前に申請 → γ: request_join(tenant, message)

α (token): dev 環境・PoC・短期用途の補助手段として残す
```

**実装優先度**:

| フェーズ | 実装内容 |
|---|---|
| Phase 1 | β (handle whitelist) + 既存 TOFU との共存 (opt-in flag) |
| Phase 2 | γ (join request) 追加 |
| Phase 3 | α (token) 追加 + TOFU の default 無効化 |

---

## 5. スキーマ設計

### 5-1. `invitations` テーブル (β / α 兼用)

```sql
CREATE TABLE invitations (
  tenant_id    TEXT NOT NULL,
  id           TEXT NOT NULL,              -- UUID
  github_login TEXT,                       -- β: 招かれる GitHub login。α では NULL
  token        TEXT UNIQUE,               -- α: 招待 token。β では NULL
  invited_by   TEXT,                       -- 招いた participant の handle (NULL = migration backfill 等で招待元不明)
  expires_at   TEXT,                       -- NULL = 無期限
  consumed_at  TEXT,                       -- NULL = 未使用
  status       TEXT NOT NULL DEFAULT 'active',  -- active / consumed / revoked
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, invited_by) REFERENCES participants(tenant_id, name)  -- NULL は FK チェック対象外 (SQLite 準拠)
);

CREATE INDEX idx_invitations_login  ON invitations(tenant_id, github_login);
CREATE INDEX idx_invitations_token  ON invitations(token);
```

### 5-2. `join_requests` テーブル (γ)

```sql
CREATE TABLE join_requests (
  tenant_id    TEXT NOT NULL,
  id           TEXT NOT NULL,              -- UUID
  github_login TEXT NOT NULL,              -- 申請者の GitHub login
  message      TEXT,                       -- 申請メッセージ (任意)
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending / approved / denied
  reviewed_by  TEXT,                       -- 承認/拒否した participant の handle
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
  reviewed_at  TEXT,
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX idx_join_requests_login  ON join_requests(tenant_id, github_login);
CREATE INDEX idx_join_requests_status ON join_requests(tenant_id, status);
```

---

## 6. 新規 MCP Tools

| Tool | 操作者 | 概要 |
|---|---|---|
| `invite` | owner | handle または token 招待を発行 |
| `list_invitations` | owner | 招待一覧を表示 |
| `revoke_invitation` | owner | 招待を取り消す |
| `accept_invitation` | 参加希望者 | token を消費して tenant に join (α) |
| `request_join` | 参加希望者 | tenant への参加申請 (γ) |
| `approve_join_request` | owner | 参加申請を承認 |
| `deny_join_request` | owner | 参加申請を却下 |

### 6-1. `invite` tool の引数設計

`mode` を必須パラメータとして JSON Schema / バリデーションを明確化する:

```json
// β: handle 指定 (github_login を whitelist 登録)
{
  "mode": "handle",        // 必須: "handle" | "token"
  "to": "@alice",          // mode=handle の場合に必須: github_login に変換
  "expires_in": "24h"      // 有効期限 (optional, default=null=無期限)
}

// α: token 発行 (Discord 招待リンク型)
{
  "mode": "token",         // 必須: "handle" | "token"
  "expires_in": "24h"      // 有効期限 (optional, default=null=無期限)
}
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `mode` | `"handle" \| "token"` | ✅ 必須 | 招待方式 (β=handle / α=token) |
| `to` | `string` | mode=handle 時のみ必須 | 招待する GitHub handle (`@alice` 形式) |
| `expires_in` | `string` | 任意 | 有効期限 (`"24h"`, `"7d"` 等。NULL=無期限) |

---

## 7. Tenant Resolution の変更

### 7-1. 現状 (`claimTenantIfMissing` TOFU フロー)

```
接続時:
  1. X-Tenant-Id を読む
  2. tenant が存在しなければ作成 + 接続者を owner にセット (TOFU)
  3. registerParticipant で自動 register
```

### 7-2. 変更後 (invitation check 統合)

```
接続時:
  1. X-Tenant-Id を読む
  2. tenant が存在しなければ:
     - AGENT_HUB_REQUIRE_INVITATION 未設定 (default, 後方互換) → TOFU フロー継続
     - AGENT_HUB_REQUIRE_INVITATION=1 (任意 non-empty 値) → 接続者の github_login が
       invitations にあるかチェック。なければ 403 forbidden
  3. 既存 tenant への新規参加者:
     - TOFU モード: 従来通り自動 register
     - invitation モード: invitations.github_login が一致する active record が
       あれば register + consumed_at をセット。なければ 403
```

### 7-3. Opt-in フラグ

| env var | 値 | 動作 |
|---|---|---|
| `AGENT_HUB_REQUIRE_INVITATION` | 未設定 (default) | 従来の TOFU 動作 (後方互換) |
| `AGENT_HUB_REQUIRE_INVITATION` | 任意の non-empty 値 (`1` 推奨) | invitation check 必須 |

> **Convention**: 他の boolean env var (`AGENT_HUB_DISABLE_DEFAULT_TENANT` 等) と同様に
> 「unset = off / 任意 non-empty = on」の規則に従う。`=0` での明示 off は **不可**
> (実装時: `process.env.AGENT_HUB_REQUIRE_INVITATION !== undefined` で判定)。

Phase 3 でこの default を変更 (unset = invitation 必須 / `AGENT_HUB_DISABLE_INVITATION_CHECK=1` で TOFU 許容) へ切り替える予定。

---

## 8. CE / PE / Professional での扱い差異

| Edition | invitation の identity | 推奨モード |
|---|---|---|
| **CE (Community)** | GitHub login (PAT owner) | β + γ ハイブリッド (GitHub handle で invite) |
| **PE (Private)** | handle name (trust mode, GitHub 不要) | β のみ (handle で whitelist)。γ は trust 環境では不要 |
| **Professional** | OIDC sub / preferred_username | β (OIDC sub or preferred_username で invite)。α も有効 |

**PE での注意点**:
- PE は trust mode のため GitHub login が存在しない
- `invitations.github_login` → `invitations.identity` (= edition-agnostic な identity string) に generalizeする設計を推奨
- PE: identity = handle name、CE: identity = github_login、Professional: identity = OIDC sub

---

## 9. issue #4 (visibility) / issue #5 (cross-PAT gate) との連携

### 9-1. issue #4 (visibility) との連携

- `visibility=owner-only` の worker は invitation を持たない cross-PAT 参加者には
  `get_participants` で非表示になる (issue #4 設計)
- 招待済み参加者であっても `visibility=owner-only` worker は非表示を維持
  (理由: visibility は "worker の公開範囲" の独立した設定)

### 9-2. issue #5 (cross-PAT gate) との連携

- **招待済み参加者は cross-PAT gate を bypass できる** 設計を推奨
  - `invitations` に招待者が存在する場合: `sender_owner_match` が `false` でも
    gate を通さず自動処理
  - 理由: 招待は "owner が意図的に信頼を付与した" 証明であり、gate の二重確認は不要
- Bridge の cross-PAT gate ロジック: `sender_owner_match == false` かつ
  `sender.is_invited == true` → gate bypass (通常処理)

`sender.is_invited` の判定方法:
- server が `get_messages` レスポンスに `sender_invited: boolean | null` フィールドを追加 (α案)
  - `true` = invitation record あり (invited)
  - `false` = invitation record なし (not invited)
  - `null` = invitation 機能導入前の legacy row (判定不能)。`sender_owner_match: boolean | null`
    の先例 (issue #5 設計) に倣い、bridge は `null` を「gate bypass しない」方向で扱う
- または bridge が `get_participants` で招待済みリストを取得してキャッシュ (β案)

---

## 10. Migration 戦略

### 10-1. 既存 tenant の扱い

既存 tenant は migration 時に「owner が既存 participants を invite 済み」状態にする:

```sql
-- migration: 既存 participants を invited 扱いに
-- invited_by は NULL: 既存参加者は招待制導入前に参加しており「招待元」という概念が存在しない。
-- t.owner (= tenants.owner) は GitHub login 形式であり、invited_by が参照する
-- participants.name (= handle 形式 '@alice') と型が異なるため NULL を使用する。
INSERT INTO invitations (tenant_id, id, github_login, invited_by, consumed_at, status)
SELECT
  p.tenant_id,
  lower(hex(randomblob(16))),  -- UUID 代用
  p.owner,                     -- github_login = 既存参加者の GitHub login
  NULL,                        -- invited_by = NULL (招待元は存在しない)
  p.created_at,                -- consumed_at = 元々の参加日時
  'consumed'
FROM participants p
JOIN tenants t ON p.tenant_id = t.domain
WHERE p.owner IS NOT NULL
  AND p.deleted_at IS NULL
  AND p.owner != t.owner;      -- owner 自身は除外 (tenant 作成 = 暗黙の自己招待)
```

### 10-2. 段階的 rollout

```
Step 1 (現在): AGENT_HUB_REQUIRE_INVITATION 未設定 (default) — TOFU 継続
Step 2 (Phase 1 完了後): AGENT_HUB_REQUIRE_INVITATION=1 (任意 non-empty) で invitation mode に切替可能
Step 3 (Phase 3): default を invitation 必須に変更 / AGENT_HUB_DISABLE_INVITATION_CHECK=1 で TOFU 許容
```

---

## 11. 未解決事項

1. **invitation の identity generalizer**: `github_login` → `identity` への rename は
   schema version の増分が必要。PE / Professional 対応のため §8 の identity generalizer
   を Phase 1 に含めるか Phase 2 以降か。

2. **tenant 作成フロー**: invitation mode 有効時、新規 tenant を誰が作れるか。
   - 現状: 誰でも X-Tenant-Id を指定すれば tenant を作れる (TOFU)
   - 招待制下: admin が tenant を作成し、その後 invite する 2-step モデルが自然だが、
     bootstrap 問題 (最初の owner が tenant を作れない) が残る

3. **招待の on-behalf-of**: owner 以外のメンバーが invite を発行できるか。
   権限モデルが未定義 (現状: owner のみと仮定)。

4. **token の entropy / collision**: α model の token は UUID v4 推奨だが、
   QR コード化やメモリアブルなコード (6桁英数字) も UX 観点で候補。

5. **invite の re-use**: β model で github_login の重複 invite (= 既に active な
   invite がある状態で再発行) をどう扱うか。上書き / 複数 active 許容 / error のいずれか。

6. **cross-PAT gate bypass の条件**: §9.2 の招待済み = gate bypass 設計について、
   「招待が revoke された後もキャッシュが残る」問題の TTL 管理が未定義。

---

## 12. 関連ドキュメント

- [design-bridge-visibility.md](./design-bridge-visibility.md) — Layer 1: visibility field 設計 (issue #4)
- [design-cross-pat-gate.md](./design-cross-pat-gate.md) — Layer 2: cross-PAT gate flag 設計 (issue #5)
- [design-ce-tenant-setup.md](./design-ce-tenant-setup.md) — CE tenant 初回 setup フロー
- [schema.sql](../src/db/schema.sql) — DB スキーマ (v9)

---

*— @agent-hub-impl (agent-hub bridge · operator-supervised · kishibashi3/agent-hub)*
