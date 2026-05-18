# packages/ — agent-hub bundled sub-components

agent-hub server 本体 (= `src/` 配下) には含めない、 **同 repo に同居させたい補助 component** をこのディレクトリに格納する。 単一 repo に置く / 別 repo を切る の判断基準は本 doc 末尾を参照。

## 現状の packages 一覧

| package | 言語 | 役割 | 起源 issue |
|---------|------|------|------------|
| [`scheduler/`](./scheduler/README.md) | Python | cron-based DM scheduler (= 定時 DM 配信 daemon、 軽量、 LLM 不要) | [#40](https://github.com/kishibashi3/agent-hub/issues/40) |

## 設計原則

### 1. 各 package は self-contained

- 独自の依存 manifest (`package.json` / `requirements.txt` 等) を持つ
- 独自の README.md が必須 (= 使い方 / 環境変数 / deployment 注意点)
- agent-hub server (= `src/`) と source レベルの import 共有はしない (= `import { ... } from '../../src/...'` は禁止)
- server とは **agent-hub MCP protocol 越し** に対話する (= 通常の peer / bridge と同じ position)

### 2. 言語 / 実装 stack は自由

- agent-hub server 本体は TypeScript だが、 packages は **用途に最適な言語** を選んでよい
- 例: `scheduler/` は軽量 daemon 用途で Python (= croniter / requests で 100 行ちょっとに収まる)
- 言語選択は package README 冒頭で明示すること

### 3. release / version は本 repo に同期

- packages の version は `agent-hub` repo の release tag に同期する (= 別 versioning しない)
- breaking change が server 側 protocol 変更を伴う場合、 同一 PR / 同一 release で flush する

### 4. CI / test は package 単位で

- 各 package の test は package 直下に置く (`packages/X/tests/` 等)
- agent-hub root の `npm test` には自動含まれない (= 言語別、 別 runner)
- CI matrix に「packages/X が触られた PR」 trigger で個別 job を追加していく方針

## packages/ に置く vs 別 repo に切る (= 判断基準)

| 条件 | → どこへ |
|------|---------|
| **release cadence を agent-hub server と同期させたい** + コードサイズ小 (= 数百行) | `packages/` |
| **server protocol と密結合** で、 server 変更と同 PR で flush したい | `packages/` |
| 独立した **roadmap / maintainer** が必要 (= bridge family のように外部 contrib 受けたい) | 別 repo (= `agent-hub-bridge-*` 系) |
| LLM 依存 / OS 依存 など **環境構築 cost** が server 本体に染み出すと困る | 別 repo |
| 外部から **plugin like に install / discover** されたい | 別 repo (= package registry 配布) |

参考: 同 ecosystem の **別 repo** で運用している peer / bridge:
- `agent-hub-bridge-claude` (= Claude Agent SDK worker)
- `agent-hub-bridge-adk` (= Google ADK + LiteLLM)
- `agent-hub-bridge-slack` (= Slack relay)
- `agent-hub-client-litellm` (= Generic LLM client)

これらは LLM 依存・独立 maintainer の都合で別 repo にしている。 一方 `scheduler/` は LLM 不要 + protocol 同期 release が望ましい (= server side `send_message` 変更時 lockstep) ため `packages/` に同居。

## 新規 package 追加 checklist

1. `packages/<name>/` に最小骨格 (`README.md` + 言語別 manifest) を作る
2. issue で目的・設計判断を残す (= 後追い読者向け context)
3. server protocol 依存があれば、 依存先 tool 名 / version を README で明示
4. root README からの cross-link は **必要時のみ**、 包括的な index は本 doc で十分

## 関連

- [docs/architecture.md](../docs/architecture.md) — ecosystem 全体構成 (server / bridge / packages の位置付け)
- [docs/agent-bridges.md](../docs/agent-bridges.md) — bridge 別 repo 側の設計 pattern (= packages との対比)
