# Dashboard UX 設計ドキュメント（draft）

> **作成**: 2026-06-06 / @ope-ultp1635  
> **ステータス**: Draft — agent-hub-impl によるレビュー・リファクタ待ち  
> **現在のダッシュボード**: http://192.168.3.45:8080 (Pi5 LAN 内)

---

## 現状のビュー構成

| View | 軸 | 性質 | 課題 |
|---|---|---|---|
| **Mesh View** | peer | 参加者と接続関係のスナップショット | 静的、今何をしているか不明 |
| **Health View** | 組織 | PPD/EQS/CDS/MOR/SHS の集計 | 過去データ、リアルタイムでない |
| **Caused-by Tree** | message | メッセージの因果チェーン | 過去志向、today の状態が埋もれる |

---

## 設計方針

### 観点1: 時間軸

| 時間軸 | 目的 | ビュー |
|---|---|---|
| **今（Now）** | 今何が起きているか | Current Tasks / Peer状態 |
| **過去（History）** | なぜこうなったか | Caused-by Tree |
| **傾向（Trend）** | 組織の健全性 | Health View / SHS |

### 観点2: 軸

| 軸 | 問い | ビュー |
|---|---|---|
| **Peer 軸**（誰が） | 各エージェントは今何をしているか | Peer Status View |
| **Task 軸**（何が） | 各タスクは今誰が担当しているか | Current Tasks View |

Peer View と Task View は同じデータの異なるピボット。

---

## 提案するビュー構成

### 1. Peer Status View（新規 / Mesh View の進化）

```
handle         | presence_state | queue | current_task              | last_active
@reviewer      | active         | 2     | PR #130 レビュー中        | 今
@voice-impl    | active         | 0     | voice 切断調査            | 2分前
@planner       | warm           | 0     | 待機中                    | 5分前
@bridges-impl  | cold           | 1     | —                         | 30分前
```

- `presence_state`（absent/cold/warm/active）+ `queue_depth` が基礎
- queue_depth が高い peer は「persona が too broad」のシグナル
- **リアルタイム**: SSE push で更新

### 2. Current Tasks View（新規）

caused_by chain の「最前線ノード」を issue/PR 単位で集約：

```
[ issue #110: on-demand bridge spawn ]
  └ @bridges-impl: PR #128-130 merge 待ち

[ voice 切断問題 ]
  └ @voice-impl: agent-hub-sdk MCP タイムアウト調査中

[ SHS Phase 2 ]
  └ @reviewer: LGTM 済み → @planner merge 待ち
```

- caused_by chain + is_online + last_active_at から導出
- **「詰まり検出」**: 同じ状態が N 時間以上続く task をハイライト

### 3. Health View（既存 / 拡張）

- 現状: PPD + EQS + CDS + MOR（Phase 2 実装済み）
- 追加予定: RBDI + SHS 統合スコア（Phase 3）
- **リアルタイム化**: OTel span stream を接続して「今の tool 実行」を表示

### 4. Caused-by Tree（既存 / そのまま）

- 過去の因果チェーン可視化（retrospective）
- Current Tasks View の「詳細ドリルダウン」として使う

---

## データフロー

```
get_participants()
  └ presence_state + queue_depth     → Peer Status View
  
caused_by chain（DB query）
  └ latest active node per root      → Current Tasks View
  
messages（DB aggregate）
  └ PPD / EQS / CDS / MOR            → Health View

OTel spans（OTLP → Jaeger）
  └ tool_use child spans             → Health View（リアルタイム）
```

---

## 実装優先度

1. **Peer Status View**: presence_state + queue_depth（issue #234）が前提
2. **Current Tasks View**: caused_by chain の最前線抽出ロジック
3. **Health View リアルタイム化**: OTel 統合（issue #195）
4. **SHS Phase 3**: RBDI + 統合スコア（Phase 2 の次）

---

## 未解決事項（レビューで検討）

1. Current Tasks の「task の単位」をどう定義するか（issue? DM thread?）
2. Peer Status の current_task はどこから取得するか（self-report? heuristic?）
3. リアルタイム更新の実装方式（SSE push vs ポーリング）
4. モバイル対応（スマホで見ることを考慮するか）
