# agent-hub Language Strategy

> **作成**: 2026-06-06 / @ope-ultp1635
> **背景**: on-demand bridge spawn (issue #110) 設計議論から整理

---

## 原則

**コアは軽く。インターフェースはサービス側に合わせる。**

- **コア（infra layer）**: 軽量・高速・省リソース → Go / Rust / TypeScript
- **インターフェース（SDK / integration layer）**: 利用者の言語に合わせる → 多言語対応

---

## エコシステム言語マップ

```
┌─────────────────────────────────────────────────────────────────────┐
│                      agent-hub Ecosystem                            │
├──────────────────────────────────┬──────────────────────────────────┤
│        Core / Infra Layer        │      Interface / SDK Layer       │
│        (軽く・速く)               │      (利用者に合わせる)            │
├──────────────────────────────────┼──────────────────────────────────┤
│                                  │                                  │
│  [TypeScript]                    │  [TypeScript]                    │
│   agent-hub server               │   agent-hub-sdk (主)             │
│   scheduler                      │   plugins (Claude Code)          │
│   dashboard ← 長期移行先         │                                  │
│                                  │  [Python]                        │
│  [Go]                            │   agent-hub-sdk (互換維持)        │
│   bridge Tier 1 (受信係) ★移行   │                                  │
│                                  │  [Java/Kotlin] ← 将来            │
│  [Rust]                          │   Enterprise SDK                 │
│   local-llm-monitor ★           │                                  │
│   OTel pipeline                  │                                  │
│   camera-agent (映像処理)         │                                  │
│                                  │                                  │
├──────────────────────────────────┴──────────────────────────────────┤
│                    ML / ADK Layer [Python]                          │
│              voice-gateway / cooking-agent / ADK連携                │
└─────────────────────────────────────────────────────────────────────┘

★ = 優先移行対象
```

---

## 現在 vs あるべき姿

| コンポーネント | 現在 | あるべき | 理由 |
|---|---|---|---|
| **agent-hub server** | TypeScript | TypeScript ✅ | messaging/routing、そのまま |
| **scheduler** | TypeScript（server 同梱） | TypeScript ✅ | そのまま |
| **dashboard** | Python (FastAPI) | TypeScript（長期） | server と統一 |
| **bridge Tier 1（受信係）** | Python | **Go** | cloud infra 常駐デーモン、k8s エコシステム |
| **bridge Tier 2（claude subprocess）** | bundled claude binary | bundled claude binary ✅ | そのまま |
| **agent-hub-sdk** | Python + TypeScript | TypeScript（主）+ Python（互換維持） | SDK は server 側言語に収束 |
| **voice-gateway** | Python (ADK) | Python ✅ | ADK が Python 前提 |
| **local-llm-monitor** | 未実装 | **Rust** (candle / llama.cpp) | Pi5 推論、計算集約 |
| **camera-agent** | 未実装 | Python or **Rust** | 映像処理の重さ次第 |
| **OTel telemetry pipeline** | Python（bridge に内包） | **Rust** | 高スループット span 処理 |
| **plugins（Claude Code）** | TypeScript | TypeScript ✅ | そのまま |

---

## 言語選定の根拠

### Go — bridge Tier 1 / cloud infra デーモン

- Kubernetes, Prometheus, Envoy など主要 cloud-native ツールと同じ言語
- シングルバイナリ、arm64 クロスコンパイル容易（Pi5 対応）
- Python の 1/5〜1/10 のメモリフットプリント
- 企業の SRE / platform engineer が読める
- **将来**: agent-hub が企業 cloud infra 上の常駐プロセスになる前提

### Rust — 計算集約コンポーネント

- local-llm-monitor: Pi5 で Gemma4 等を動かす推論部分（candle / llama.cpp）
- 音声 DSP: PCM リサンプリング・エンコード等
- OTel pipeline: 大量スパンの高スループット処理
- **使い所**: 「計算集約的」かつ「低レイテンシ必須」な部分

### TypeScript — server / SDK / plugins

- agent-hub server の言語として確立済み
- SDK の主力言語
- フロントエンド寄りの開発者も参加しやすい

### Python — ML / ADK 連携コンポーネント

- Google ADK が Python 前提（voice-gateway）
- ML フレームワーク連携（cooking-agent 等）
- 既存 bridge の移行期間は Python で継続

### Java / Kotlin — Enterprise SDK（将来）

- Enterprise Edition 展開時に Java スタックの企業向け SDK として提供
- コアには不要（JVM オーバーヘッドが合わない）

---

## 移行優先度

1. **bridge Tier 1 → Go** (issue #110): 6/15 課金変更対応も兼ねて優先
2. **local-llm-monitor → Rust** (issue #224): Pi5 推論基盤
3. **dashboard → TypeScript**: 長期、急がない

---

## 関連

- [on-demand bridge spawn design](https://github.com/kishibashi3/agent-hub-bridges/issues/110)
- [local-llm-monitor](https://github.com/kishibashi3/agent-hub/issues/224)
- [edition model](./edition-model.md)
