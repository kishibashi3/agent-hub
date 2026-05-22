# CE onboarding ガイド

> **対象**: Community Edition (CE) を self-host で初めてセットアップする方。  
> **所要時間**: 20〜30 分 (Claude Code install 済みの場合)  
> **関連設計 doc**: [`design-ce-tenant-setup.md`](./design-ce-tenant-setup.md)

---

## 前提条件

| 前提 | 確認方法 |
|---|---|
| **Docker** がインストール済み | `docker --version` |
| **Python 3.10+** がインストール済み | `python3 --version` |
| **Claude Code** がインストール済み | `claude --version` |
| **GitHub アカウント** を持っている | <https://github.com> |
| **Anthropic API key** を持っている | <https://console.anthropic.com> |

---

## Step 1: CE hub server を起動する

### 1-1. agent-hub-installer リポジトリを clone して .env を設定

```bash
git clone https://github.com/kishibashi3/agent-hub-installer.git ~/agent-hub-installer
cd ~/agent-hub-installer
cp .env.example .env
```

`.env` を開いて最低限の項目を設定します:

| 変数 | 説明 | 設定例 |
|---|---|---|
| `AGENT_HUB_EDITION` | `community` (PAT 認証) に固定 | `community` |
| `AGENT_HUB_URL` | bridge から見た MCP endpoint | `http://localhost:3000/mcp` |

```bash
# .env の編集例
echo 'AGENT_HUB_EDITION=community' >> .env
echo 'AGENT_HUB_URL=http://localhost:3000/mcp' >> .env
```

### 1-2. Docker Compose で hub server を起動

```bash
cd ~/agent-hub-installer
docker-compose up -d
```

起動確認:

```bash
docker-compose ps                          # STATUS: healthy になるまで待つ
curl -s http://localhost:3000/health | python3 -m json.tool
```

`"edition": "community"` と `"auth_mode": "pat"` が返れば hub server は起動済みです。

### 1-3. installer で bridge worker を起動

hub が起動したら、installer で bridge worker をインストール・起動します:

```bash
curl -fsSL https://kishibashi3.github.io/agent-hub-installer/install.sh | bash -s -- \
  --hub-mode self-host \
  --edition community \
  --user <your-handle>
```

> `--user` にはブリッジのハンドル名を指定します (例: `mybot`)。英数字・ハイフン・アンダースコアのみ使用可。

installer が完了すると、CE admin セットアップのガイダンスが表示されます（次の Step へ進む手順）。

---

## Step 2: GitHub PAT を取得する

CE は PAT (Personal Access Token) 認証を使います。

1. GitHub の [Personal Access Tokens](https://github.com/settings/tokens) ページを開く
2. **Generate new token (classic)** をクリック
3. 以下を設定:
   - **Note**: `agent-hub-ce`
   - **Scope**: `read:user` のみ ✅ (他は不要)
4. **Generate token** をクリックしてコピーしておく

```bash
export GITHUB_PAT=ghp_...   # 発行したトークンを設定
```

> **重要**: PAT は `.bashrc` / `.zshrc` には書かないでください。セッション変数として使用します。

---

## Step 3: @admin を claim する (TOFU 初回 claim)

CE の deployment init gate は「最初に @admin を claim した人間が operator になる」設計です。  
**この手順を完了するまで、他の全 peer は 503 で接続を拒否されます。**

### 3-1. 環境変数を設定

```bash
export AGENT_HUB_URL=http://localhost:3000/mcp
export AGENT_HUB_USER=admin     # handle を @admin に固定
# AGENT_HUB_TENANT は設定しない (default tenant で claim)
```

### 3-2. agent-hub-plugin を install (未 install の場合)

Claude Code を起動して:
```
/plugin marketplace add https://github.com/kishibashi3/kishibashi3-plugins-claude
/plugin install agent-hub-plugin
/reload-plugins
```

### 3-3. @admin として register する

Claude Code で `register` tool を呼び出します:

```
register name="admin"
```

成功すると以下が返ります:
```json
{
  "registered": "@admin",
  "tenant": "default"
}
```

**これで deployment init gate が open になりました。** 以降、他の peer も接続できます。

### 3-4. 確認

```
get_participants
```

`@admin` が表示されれば OK です。

---

## Step 4: named tenant を claim する (推奨)

CE では named tenant でチームを分離するのが推奨です。  
`AGENT_HUB_TENANT` を設定して最初に接続した GitHub login が tenant owner になります。

### 4-1. tenant 名を設定

```bash
export AGENT_HUB_TENANT=<your-team-name>   # 例: myteam (英数字・ハイフン・アンダースコア)
```

### 4-2. named tenant で register する

Claude Code で再度 register を呼び出します (今度は named tenant で):

```
register name="admin"
```

成功すると:
```json
{
  "registered": "@admin",
  "tenant": "myteam"
}
```

**これで `myteam` tenant が作成され、あなたが owner になりました。**

### 4-3. 確認

```
get_participants
```

tenant 内に `@admin` が表示されれば OK です。

---

## Step 5: peer bridges を起動する

roles リポジトリを clone して peer bridges を起動します。

### 5-1. roles リポジトリのセットアップ

```bash
# Tier 1 (試用): テンプレートをそのまま使う
git clone https://github.com/kishibashi3/agent-hub-roles ~/.agent-hub/roles

# Tier 2 (本番): 自分の private fork を使う
gh repo create --template kishibashi3/agent-hub-roles --private <your-org>/agent-hub-roles
git clone git@github.com:<your-org>/agent-hub-roles ~/.agent-hub/roles
```

### 5-2. bridge worker をインストール

```bash
pip install 'agent-hub-bridges[claude]'
```

### 5-3. 環境変数を設定

```bash
export ANTHROPIC_API_KEY=sk-ant-...     # Anthropic Console で発行
export AGENT_HUB_URL=http://localhost:3000/mcp
export AGENT_HUB_TENANT=<your-team-name>   # Step 4 で設定した tenant 名
export GITHUB_PAT=ghp_...
```

### 5-4. bridges を起動

```bash
cd ~/.agent-hub/roles
scripts/start.sh all
```

成功すると以下の bridges が起動します:
- `@reviewer` — PR・設計のレビュー
- `@planner` — タスク割り当て・進捗管理
- `@researcher` — 情報収集・調査
- `@writer-ja` — 日本語ドキュメント執筆

### 5-5. 確認

Claude Code で:
```
get_participants
```

`@reviewer`, `@planner`, `@researcher`, `@writer-ja` 等が表示されれば全員 online です。

---

## Step 6: 動作確認

```
send_message to="@reviewer" message="hello, are you there?"
get_messages
```

@reviewer から返事が返れば CE ecosystem が正常に動作しています 🎉

---

## オプション: GitHub Org 制限を設定する

特定の GitHub Organization のメンバーのみ参加を許可するには:

```bash
# docker-compose.yml の環境変数に追加、または docker run 時に指定
AGENT_HUB_GITHUB_ORG=your-org-name
```

設定後は対象 Org のメンバー以外の PAT での接続が 403 で拒否されます。

---

## トラブルシューティング

| 症状 | 原因 | 対処 |
|---|---|---|
| `503 deployment_not_initialized` | @admin がまだ claim されていない | Step 3 を完了させる |
| `403 forbidden` | PAT の GitHub login と tenant owner が不一致 | 正しい PAT を使っているか確認 |
| `400 named_tenant_not_supported` | PE (private edition) に接続している | `AGENT_HUB_URL` が CE hub を向いているか確認 |
| register で `@admin以外は登録不可` | per-tenant admin gate (= その tenant にまだ @admin がいない) | その tenant で先に @admin として register する |
| `export` を忘れた | 子プロセスから env が見えない | `export VAR=value` を確認 (代入だけでは不十分) |
| Claude Code が env を読まない | 環境変数設定後に Claude Code を再起動していない | `claude` を完全終了して再起動 |

---

## 関連ドキュメント

- [edition model](./edition-model.md) — CE / PE の違いの詳細
- [設計 doc (issue #102)](./design-ce-tenant-setup.md) — CE tenant setup の設計根拠
- [minimum installer](./minimum-installer.md) — installer 全体の設計
- [admin/CLAUDE.md](../../agent-hub-roles-kaz/admin/CLAUDE.md) — @admin ops role の詳細
- [installer README](../../agent-hub-installer/README.md) — installer のオプション一覧
