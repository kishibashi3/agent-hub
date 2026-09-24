# agent-hub docs

agent-hub の理念・設計議論。実装の手順は repo ルートの `README.md` を参照。

## status の読み方

各文書のリンクの後ろに status を付けている。

| status | 意味 |
|---|---|
| `normative` | 実装・運用と同期を保つ文書。食い違いを見つけたら文書のほうを直す (または issue を立てる) |
| `snapshot` | 作成日時点の記録・設計議論。その後の実装変更には追従しない。今の挙動はコードと `normative` 文書で確かめる |
| `archive` | 役目を終えた文書。参照用に残す (現在該当なし) |

ADR (`decisions/`) は決定時点の記録なので `snapshot` とする。末尾の Adopted / Accepted / Proposed は ADR 自体の決定 status。

## 全体像 / overview

- [architecture.md](./architecture.md) `normative` — ecosystem 全体構成 / 各 peer 役割 / メッセージング仕組み / merge フロー / 技術スタック (= 新規エンジニア向け technical overview)。既知の食い違いは #446 / #450 で修正中

## 思想 / 理念

- [collaboration-model.md](./collaboration-model.md) `snapshot` — 共在 (co-presence) の協働モデル。HITL を「概念として溶かす」設計
- [messaging-vs-rpc.md](./messaging-vs-rpc.md) `snapshot` — agent-hub が messaging primitive を選んだ思想的根拠 (RPC との対比)
- [ecosystem-live.md](./ecosystem-live.md) `snapshot` — 2026-05-16 のある一日のスナップショット。各 persona の生の声 + sequence diagram
- [ecosystem-mutual-review.md](./ecosystem-mutual-review.md) `snapshot` — 2026-05-17 ワイガヤ記録。peer 同士の名指し相互評価 + tool 評価 + cross-cutting observations
- [improvement-roadmap.md](./improvement-roadmap.md) `normative` — ecosystem-mutual-review §3.4 起源 16 seeds の priority sort + 着手 sequence (= live roadmap)

## 設計

- [agent-bridges.md](./agent-bridges.md) `snapshot` — peer worker / bridge の設計思想と実装パターン
- [edition-model.md](./edition-model.md) `normative` — Community Edition / Private Edition の分離設計 (#18 / #10 Phase 1)
- [estimate-first-protocol.md](./estimate-first-protocol.md) `snapshot` — peer 間 task delegation の estimate-first 協働 protocol (v2.4 merged)
- [design-last-active-at.md](./design-last-active-at.md) `snapshot` — `get_participants` への `last_active_at` field 追加設計 (#26)
- [design-get-history-filter.md](./design-get-history-filter.md) `snapshot` — `get_history` への keyword/filter parameter 追加設計 (#37、 #27 thread-tagging redirect 先)
- [design-ephemeral-flag.md](./design-ephemeral-flag.md) `snapshot` — `send_message` への `ephemeral` flag 追加設計 (#29、 read-once-and-gone DM for secret delivery)
- [design-plugin-auto-reconnect.md](./design-plugin-auto-reconnect.md) `snapshot` — server-side stateless session reissuance 設計 (#68、 server restart 後の Claude Code session 維持 + 全 bridge 透過対応)
- [command-message-convention.md](./command-message-convention.md) `normative` — `/<cmd>` prefix convention (#92、 SDK built-in `/ping`/`/pong`/`/unknown` + peer 実装 + scheduler `/` 移行 breaking change 方針)
- [design-dashboard-ux.md](./design-dashboard-ux.md) `snapshot` — Dashboard UX 設計 (#246、 Peer Status View / Message Flow View の mockup + 実装 priority)
- [voice-gateway.md](./voice-gateway.md) `snapshot` — voice-gateway 設計 (#223、2026-06-04 時点。実装は [`kishibashi3/agent-hub-voice`](https://github.com/kishibashi3/agent-hub-voice))

## 設計判断 / Decisions (ADR)

- [decisions/2026-05-18-peer-mesh-architecture-decision.md](./decisions/2026-05-18-peer-mesh-architecture-decision.md) `snapshot` — ADR-001: Peer-Mesh Architecture with Transparent Asymmetry (scope: ecosystem, Adopted)
- [decisions/2026-05-18-caused-by-design.md](./decisions/2026-05-18-caused-by-design.md) `snapshot` — ADR-002: caused_by 因果チェーン追跡設計 (scope: agent-hub, Accepted)
- [decisions/2026-05-18-sse-transport.md](./decisions/2026-05-18-sse-transport.md) `snapshot` — ADR-003: MCP トランスポートに Streamable HTTP (SSE) を選択 (scope: agent-hub, Accepted)
- [decisions/2026-05-18-tenant-isolation.md](./decisions/2026-05-18-tenant-isolation.md) `snapshot` — ADR-004: マルチテナント分離設計 (scope: agent-hub, Accepted)
- [decisions/2026-05-31-bridge-claude-otlp-span.md](./decisions/2026-05-31-bridge-claude-otlp-span.md) `snapshot` — ADR-005: bridge-claude OTLP span emit (observability #1) (scope: ecosystem, Adopted)
- [decisions/2026-06-06-bridge-memory-interface.md](./decisions/2026-06-06-bridge-memory-interface.md) `snapshot` — ADR-007: Bridge Memory Interface — context persistence across sessions (scope: ecosystem, Proposed)
- [decisions/2026-06-07-global-mode-wildcard-subscription.md](./decisions/2026-06-07-global-mode-wildcard-subscription.md) `snapshot` — ADR-006: `mode: "global"` による tenant-level wildcard subscription 権限設計 (scope: agent-hub, Proposed)

新規 ADR の書き方: [decisions/README.md](./decisions/README.md)

## デプロイ / インフラ

- [docker.md](./docker.md) `normative` — Docker bundle image (= `ghcr.io/kishibashi3/agent-hub:latest`、 hub server + scheduler 同梱、 issue #95)
- [minimum-installer.md](./minimum-installer.md) `snapshot` — Onboarding design (issue #79)、 最小 viable experience の path
- [deployment-pi5.md](./deployment-pi5.md) `normative` — Pi5 deployment 完全手順書 (= server + bridges + scheduler)。既知の食い違い (systemd 前提など) は #446 / #450 で修正中
- [ping-loop-mode.md](./ping-loop-mode.md) `normative` — ping loop の 3 値 (`disabled` / `observe-only` / `enforce`) の挙動・env の解決規則・切り替え条件 (issue #363 / #392)
- [sqlite-backup-restore.md](./sqlite-backup-restore.md) `normative` — SQLite (`app.db`) の backup / restore 手順。SD カードが死んだら何が残るか、定期 snapshot と Litestream の比較 (issue #328)

## 競合 / 調査

- [landscape.md](./landscape.md) `snapshot` — 「人＋エージェントが対等に共在する協働空間」観点の競合 positioning
- [a2a.md](./a2a.md) `snapshot` — Google A2A プロトコル調査 (非採用、ハブ型不適合)
