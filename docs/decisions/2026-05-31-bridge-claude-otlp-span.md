# ADR-005: bridge-claude OTLP span emit (observability #1)

**Number**: ADR-005
**Status**: Adopted
**Date**: 2026-05-31
**Scope**: ecosystem
**Participants**: @bridges-impl (impl), @planner (dispatch), @ope-ultp1635 (operator L1 GO)
**Issue**: kishibashi3/agent-hub-bridges#90

> この判断は @ope-ultp1635 の operator DM (2026-05-31) により確定。
> caused_by: f99e5b95-d5ab-4392-a1e9-d2db5ae6d0b4 (operator DM ID)
> dispatch: @planner DM 9a5975e6-c00c-415e-b7cd-4d8b0b81f5ff
> セッションが出所: 2026-05-31

---

## Context

bridge-claude は `claude_agent_sdk` 経由で LLM を呼び出すが、各呼び出しの
token 消費・latency・成否を外部から観測する手段がなかった。

operator がローカル LAN 上の OTLP コレクタ (otelite、`192.168.3.45:4318`) を
セットアップ済みであり、bridge 側からスパンを送信できる環境が整った。

Python の OpenTelemetry エコシステムは標準的なライブラリとして確立されており、
`opentelemetry-sdk` + `opentelemetry-exporter-otlp-proto-http` の組み合わせで
OTLP/HTTP (`Content-Type: application/x-protobuf`) 形式の span export が可能。
(v1.42.1 は protobuf のみサポート。otelite は protobuf を受け付け、スパンは正常に届く。)

---

## Decision

bridge-claude に per-call OTLP span emit を追加する:

1. **トリガー**: `_handle_one()` 内で `receive_response()` ループが `ResultMessage`
   を受信した直後 (= LLM 1 ターン完了)

2. **Span 属性** (GenAI semantic conventions + custom):
   - `msg_id`: agent-hub message ID (custom、因果チェーン追跡)
   - `gen_ai.request.model`: 呼び出した Claude model 名
   - `gen_ai.usage.input_tokens`: 入力 token 数
   - `gen_ai.usage.output_tokens`: 出力 token 数
   - `gen_ai.usage.cache_read.input_tokens`: キャッシュ読み取り token 数
   - 属性名は **ドット区切り** (アンダースコア不可)

3. **フォーマット**: OTLP/HTTP (`POST /v1/traces`、
   `Content-Type: application/x-protobuf`)。
   `opentelemetry-exporter-otlp-proto-http` v1.42.1 は protobuf のみをサポートする。
   otelite は protobuf を受け付け、span は正常に届くことを実機確認済み (bridges#91 commit b431172)。

4. **Opt-in**: `AGENT_HUB_TELEMETRY_URL` 未設定時はサイレント skip (bridge の
   デフォルト動作を変えない)

5. **Graceful degradation**: opentelemetry 未インストール・span emit 例外は
   `logger.warning` で読み捨て — bridge 停止はしない

6. **依存追加**: `claude` extra に `opentelemetry-sdk>=1.25.0` +
   `opentelemetry-exporter-otlp-proto-http>=1.25.0` を追加

---

## Consequences

### Positive
- LLM 呼び出しごとの token 消費・成否を otelite で可視化できる
- `msg_id` を span に付与することで agent-hub のメッセージ因果チェーンと
  OTLP トレースを紐付けられる
- Opt-in 設計のため既存デプロイに影響なし (追加 env 1 本で有効化)
- `BatchSpanProcessor` による非同期 export でブリッジの latency に影響しない

### Risks / Trade-offs
- `usage` dict の構造は `claude_agent_sdk.ResultMessage.usage` (Anthropic API
  レスポンスの `usage` field) に依存する。SDK の API 変更時は本モジュールも更新要。
- キャッシュ token の key 名 (`cache_read_input_tokens`) は Anthropic API の
  命名規則に従う (OTel 属性名とは異なる)。
- `gen_ai.*` 属性は OpenTelemetry GenAI Semantic Conventions (draft) に基づく。
  conventions が stable になった際にキー名が変わる可能性がある。

## Related

- Refs: kishibashi3/agent-hub-bridges#90
- 実装 PR: kishibashi3/agent-hub-bridges#91 (commit b431172)
- operator DM: f99e5b95-d5ab-4392-a1e9-d2db5ae6d0b4
- otelite deployment: `private/agent-hub/docs/deployment-pi5.md`
- OpenTelemetry GenAI Semantic Conventions:
  https://opentelemetry.io/docs/specs/semconv/gen-ai/
