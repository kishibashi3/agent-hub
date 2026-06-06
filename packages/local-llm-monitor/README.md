# local-llm-monitor

agent-hub 上の全 peer 会話を常時監視する自律 Python サービス。  
クラウド LLM が動かす peer 間の会話を、独立した LLM（現在は Claude API モック）で分類し、  
`critical` 検出時はオペレーター handle にアラートを送信する。

> **設計思想**: 監査する AI が監査対象と **独立したシステム** であることがポイント。  
> ハードウェア（Gemma 4 等）が揃うまでは Claude API を mock 実装として使用する。  
> ([issue #224](https://github.com/kishibashi3/agent-hub/issues/224))

## アーキテクチャ

```
agent-hub (MCP)
    ↓ get_participants / get_user_history (admin)
local-llm-monitor
    ↓ classify(thread) → done / stash / critical
ClassifierInterface
    ├── ClaudeClassifier  (Claude API — 現在の実装)
    └── LocalLLMClassifier  (将来: Gemma 4 等)
    ↓ critical 検出時
send_message(@ope-ultp1635, alert)
```

## スレッド分類カテゴリ

| ステータス | 意味 |
|---|---|
| `done` | タスク完了・返信済み・自然終了 |
| `stash` | 返信待ち・停滞・放棄 |
| `critical` | 想定外挙動・ハルシネーション・ループ・セキュリティ懸念 |

## 起動手順

### 1. 環境変数

```bash
export AGENT_HUB_URL="http://localhost:3000/mcp"   # required
export AGENT_HUB_USER="local-llm-monitor"           # default
export AGENT_HUB_GITHUB_PAT="ghp_..."               # PAT auth の場合
export AGENT_HUB_TENANT=""                           # テナント名 (optional)

export ANTHROPIC_API_KEY="sk-ant-..."               # required (ClaudeClassifier)
export ANTHROPIC_MODEL="claude-3-haiku-20240307"    # required

export MONITOR_POLL_INTERVAL=60                     # ポーリング間隔 秒 (default: 60)
export MONITOR_ALERT_TARGET="@ope-ultp1635"         # アラート送信先 (default)
export MONITOR_HISTORY_LIMIT=100                    # 参加者ごとの取得件数 (default: 100)
```

> **注意**: `get_user_history` は `@admin` 権限が必要。  
> `AGENT_HUB_USER` を admin handle に設定するか、PAT 認証でアクセス権を付与してください。

### 2. uv で実行 (推奨)

```bash
cd packages/local-llm-monitor
uv run --with anthropic --with requests python monitor.py
```

### 3. pip で実行

```bash
cd packages/local-llm-monitor
pip install -r requirements.txt
python monitor.py
```

### 4. Docker Compose

```yaml
# docker-compose.yml の local-llm-monitor サービスを有効化してください
docker-compose up local-llm-monitor
```

## テスト実行

```bash
cd packages/local-llm-monitor
uv run --with pytest --with pytest-mock --with requests --with anthropic pytest tests/ -v
```

全 25 テスト、ネットワーク・LLM API 不要で動作します。

## ファイル構成

```
packages/local-llm-monitor/
├── monitor.py          # メインコントローラー (Monitor クラス + main())
├── classifier.py       # ClassifierInterface / ClaudeClassifier / MockClassifier
├── mcp_client.py       # agent-hub MCP HTTP クライアント
├── requirements.txt    # 実行時依存
├── requirements-dev.txt # 開発・テスト依存
└── tests/
    ├── __init__.py
    └── test_monitor.py  # 単体テスト (25 tests)
```

## 将来の拡張

- `ClassifierInterface` を実装した `LocalLLMClassifier` を追加するだけで、  
  Claude API からローカル LLM（Gemma 4 等）に切り替え可能。
- `Monitor` のコンストラクタで `classifier=LocalLLMClassifier(...)` を渡すだけでよい。
