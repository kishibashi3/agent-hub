# Design: MCP session auto-reconnect after server restart (#68)

> [issue #68](https://github.com/kishibashi3/agent-hub/issues/68) (= server 再起動後に Claude Code セッション再起動が不要になる auto-reconnect 機能) の **設計 doc**。 実装 PR は本 doc LGTM 後に別 PR で起草する 2 段ゲート構成。

## 1. 概要

agent-hub server (= TypeScript MCP server) が再起動すると、 in-memory `sessions: Map<string, Session>` が消失し、 既存 client (= Claude Code 内蔵 MCP client、 bridge-claude、 bridge-adk 等) が持つ stale `mcp-session-id` は次の tool call で **400 `Bad Request: missing/invalid session`** で reject される。 現状 Claude Code 側は auto-reconnect しないため、 user は **Claude Code session ごと再起動** が必要。

本設計は **server-side stateless session reissuance** (= 不在 session ID + 有効 auth → server が auto-create + process request) を採用し、 client 側を一切変更せずに 「server restart → 透過的復帰」 を実現する。

## 2. 設計方向の選択肢

### (α) server-side stateless session reissuance ← 採用案
- 不在 session ID で `POST /mcp` (= initialize 以外の request) が来た場合、 **server が同 request の auth 情報 (= X-User-Id / GITHUB_PAT) を再検証 → 有効なら新 session を auto-init → 同じ request body をその session で process** する path を追加
- response の HTTP header に新 session ID を含める (= 既存 MCP の `mcp-session-id` response header と同形)
- client は **完全に変更不要** = 既存 Claude Code / bridge-claude / bridge-adk / scheduler 等全 peer が恩恵
- 既存 auth 経路 (`authenticateUser` middleware) を毎 request 通るので **security regression なし** (= 不正 PAT で session reissuance は不可)

### (β) plugin-side intercepting proxy daemon
- agent-hub-plugin が小さな HTTP proxy daemon を spawn、 Claude Code → proxy → agent-hub server の経路に介在
- proxy が 400 session error を検出 → transparently re-init + retry → client (= Claude Code) には成功 response を返す
- 利点: server 側の semantic を変えない (= 「不在 session ID は不在のまま」 を維持)
- 欠点:
  - 各 client (= Claude Code、 各 bridge) に proxy 設定が必要 = 全体 deploy 影響大
  - proxy daemon の lifecycle 管理 (= start / stop / crash recovery) を plugin 側で持つ必要
  - 1 hop 増えるので latency + failure mode 拡大

### (γ) server-side session persistence
- `sessions` Map を SQLite (= `app.db`) に persist、 server restart 時に load して memory 復元
- client の session ID がそのまま valid であり続ける
- 利点: 完全 transparent (= client から見ると server restart が観測されない)
- 欠点:
  - session state (= transport object + Server object + subscribed URIs Set) は **runtime-only object** で persist 不可能要素を多く含む
  - subscribed URIs は restore できても SSE stream 自体は切断されるため、 「session ID 維持」 だけでは insufficient (= client は SSE 再接続必要、 結局 watch.sh の reconnect loop 経由)
  - tool call path だけ救うなら α 案で十分、 γ は over-engineering

### author preference: **(α)**

理由:
1. **client 側変更ゼロ** (= Claude Code internal を変更できない制約に整合)
2. **既存 bridges (= bridge-claude / bridge-adk / scheduler) も恩恵** (= 全 MCP client が server restart に耐性を得る)
3. **security regression なし** = `authenticateUser` middleware が毎 request 通る既存設計を活用、 不在 session = 「新規 init すべき」 と扱うだけ
4. **MCP spec 違反ではない** (= MCP 仕様は 「server は session ID を持たないと initialize required」 と書いてあるが、 「不在 session ID を auto-init してはいけない」 とは書いていない、 implementation choice の余地)
5. β / γ と比較して **実装範囲が極小** (= server.ts 内 1 path の追加、 ~30 LOC 規模)

(β) は client 側 deploy impact 大、 (γ) は SSE stream 切断問題が残るので解決にならない。

## 3. (α) の詳細仕様

### 3.1 trigger 条件

`POST /mcp` で以下 **全条件** を満たすとき、 session を auto-reissue:

1. `mcp-session-id` header が **設定されている** (= client が session を持っていると主張)
2. その session ID が **`sessions` Map に不在** (= server restart 後の stale session)
3. request body が **`initialize` 以外の method** (= `tools/call` / `resources/subscribe` / `notifications/*` 等)
4. `authenticateUser` middleware が **成功して `req.userId` / `req.githubLogin` / `req.tenantDomain` を set** (= 認証は valid)

以上 4 条件を満たさない場合は **既存 behavior と同じ** (= 400 / 401 等を return):
- 条件 1 + 2 + 3 を満たすが 4 が失敗 → 既存 401 path (= 認証エラー)
- 条件 1 が偽 + body が initialize → 新規 session 作成 (= 既存 path)
- 条件 1 が偽 + body が initialize 以外 → 400 (= 既存 path)
- 条件 2 が偽 (= 既知 session) → 既存 session に dispatch (= 既存 path)

### 3.2 reissuance 動作

trigger 条件成立時の処理:

```typescript
// src/mcp/server.ts: POST /mcp handler 内に追加
if (sessionId && !sessions.has(sessionId)) {
  // ★ trigger 条件: sessionId 設定済 + 不在 + 認証 valid
  // 既存 400 path に倒す前に reissuance を試みる

  if (isInitializeRequest(req.body)) {
    // initialize なのに session ID 付いてる = client の状態異常
    // → 既存 400 / 401 path に倒す (= 後述 §3.4 edge case 参照)
  } else {
    console.log(
      `[MCP] session ${sessionId} unknown (= server restart?), ` +
      `reissuing for userId=${userId} tenant=${tenantDomain}`
    );

    // 新規 session を init (= 既存 initialize path と同じ logic)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      eventStore: notificationEventStore,
      onsessioninitialized: (newSid) => {
        sessions.set(newSid, {
          transport, server, userId, githubLogin, tenantDomain,
          subscribedUris: new Set(),
        });
        console.log(`[MCP] session reissued: ${newSid} (replaces stale ${sessionId})`);
      },
    });
    transport.onclose = () => { /* 既存と同じ */ };
    const server = createMcpServer();
    await server.connect(transport);

    // ここで重要: original request body は initialize ではないが、 transport は
    // initialize を expect する。 解決方法 2 通り:
    // (a) 内部で initialize request を inject してから real request を process
    // (b) transport の internal API を直接叩いて initialize step を bypass
    //
    // (a) は spec-correct path、 (b) は cleaner だが SDK 内部依存。
    // 詳細は §3.3 参照。
    await dispatchReissuedRequest(transport, req, res);
  }
}
```

### 3.3 reissuance の MCP プロトコル整合性

new session を作っただけでは MCP プロトコル上 `initialize` が完了していない状態。 そのまま `tools/call` を transport.handleRequest に渡すと SDK が 「not initialized」 として reject する可能性が高い。

**解決案 (a)**: 内部で initialize を synthesize:

```typescript
async function dispatchReissuedRequest(transport, req, res) {
  // 1. synthetic initialize request を transport に渡す (response は捨てる)
  const initReq = {
    jsonrpc: '2.0',
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'agent-hub-reissue', version: '1.0' },
    },
    id: 'reissue-init',
  };
  const dummyRes = createDummyResponse();
  await transport.handleRequest(req, dummyRes, initReq);

  // 2. notifications/initialized も synthesize
  await transport.handleRequest(req, dummyRes, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });

  // 3. 元の request を新 session で process
  await transport.handleRequest(req, res, req.body);
}
```

**解決案 (b)**: SDK 内部 API 経由で初期化フェーズ skip
- SDK が internal initialized state を直接 set できる method を expose しているか調査必要
- 公開 API でないなら fragility 高い (= SDK 更新で break)

**author preference: (a)** = spec-correct path、 SDK 公開 API のみ使用、 future-proof。 implementation PR で **dummy response object の handling** (= header 競合 / write race) を careful に。

### 3.4 edge case

| ケース | 期待 behavior | 既存 path? |
|---|---|---|
| 不在 session + initialize request 同時 | 401 or 400 で reject (= initialize なら session ID を付けてはいけない MCP 仕様) | yes (既存 400) |
| 不在 session + 認証失敗 | 401 (= 既存 path) | yes |
| 不在 session + auth valid だが tenant 不一致 | 既存 stale session の tenant context は失われたので、 **request の auth context (= new tenant)** で reissue | ★ new behavior |
| reissue 直後 race (= 同 session ID で複数 request) | 1 回目: reissue path / 2 回目以降: 新 session ID が `sessions` に入っているので既存 dispatch path | natural |
| reissue 中に server crash | next request で再度 reissue (= idempotent) | natural |
| client が **古い session ID** を quote していて、 別 user が **同じ session ID** を以前持っていた場合 | auth は **request の auth context** で再 validate される (= 古い session の owner は無関係)、 session leak risk なし | new behavior |

### 3.5 subscribed URIs の取り扱い

`Session.subscribedUris: Set<string>` は session 単位の state (= 「この session が subscribe している inbox URI」 の集合)。 reissue 後の new session の `subscribedUris` は **空** で start。

これにより:
- watch.sh が 「server restart 後の SSE 再接続」 で `resources/subscribe` を再発行する必要がある
- 既に watch.sh は `while true; do ... done` loop で sub 再発行する設計 = compatible
- bridges (= bridge-claude / bridge-adk) も同様に reconnect 時 sub 再発行が必要
- **subscribe state は session level であるべき** (= server crash で失われる前提) を明示

これは本 PR 設計の **意図的な scope 制限** (= subscribe state persistence は γ 案の subset、 別 issue 候補)。

## 4. server-side response 形式

reissuance path の response は **既存 success path と同じ** (= JSON-RPC success response、 `mcp-session-id` header に新 ID)。

client は header 経由で新 session ID を取得 (= MCP transport の標準 path)、 以降 request で新 session ID を使用。 transparency 完全。

明示的に診断したい場合の **optional header**:
- `X-Agent-Hub-Session-Reissued: <stale-session-id>` を response に付与 (= debug / log 用途)
- production では log 出力で十分なので **本 PR scope では追加しない** (= 後の observability PR 候補)

## 5. security 観点

### 5.1 PAT 変更検出

session reissuance は **request の auth context** で validation する。 これにより:
- 古い session の owner (= PAT A) が無効化されても、 request が PAT B (= 新 PAT) で来れば PAT B として reissue
- → 古い PAT が leak しても、 server restart 後は無効 PAT で reissue できない (= 既存 `authenticateUser` の PAT 検証で reject)
- → security regression なし、 むしろ **stale session ID + 有効 auth の整合性が毎 request 取れる** ので改善

### 5.2 tenant 変更検出

CE で同 PAT が tenant A と tenant B 両方を register できる場合、 session reissue は **request 時の tenant** で進む。
- 古い session が tenant A、 reissue 時 request が tenant B → 新 session は tenant B
- → tenant 越境はしない (= TOFU / X-Tenant-Id header の既存 enforce path)

### 5.3 rate-limit considerations

reissuance path が毎 request 走ると効率が悪い (= 古い session ID を持つ client が無限ループ的に new session を作り続ける可能性)。 ただし通常 use case では:
- client は response header の new session ID を即座に取り込む (= MCP transport の標準 behavior)
- 次の request からは新 session ID を使う = reissuance path は 1 回しか走らない

念のため per-(userId, source-IP) で **N 秒に 1 reissue** rate-limit を入れる余地あり (= 別 PR で観察後判断)。 本 PR では rate-limit 無しで start。

### 5.4 audit log

reissuance の log は **常に出力** (= 「server restart 後の auto-recovery 観察」 用途):
```
[MCP] session ${stale_sid} unknown (= server restart?), reissuing for userId=${userId} tenant=${tenantDomain}
[MCP] session reissued: ${new_sid} (replaces stale ${stale_sid})
```

ops が 「restart 後の reconnect 成功件数」 を log で観察可能 = audit trail。

## 6. 実装 surface (= 別 PR scope hint)

### 6.1 server-side 変更
- `src/mcp/server.ts` POST /mcp handler に reissuance path 追加 (~30 LOC)
- `dispatchReissuedRequest` helper を新規 (= synthetic initialize → real request の 3 step)
- `sessions: Map<string, Session>` の data structure 不変

### 6.2 client-side 変更
- **なし**。 既存 Claude Code / bridge-claude / bridge-adk / scheduler / watch.sh 全て無修正で動作

### 6.3 plugin (= agent-hub-plugin) 変更
- 不要。 watch.sh は既存 reconnect loop でそのまま動作

### 6.4 documentation
- `README.md` の 「既知の問題」 section から 「agent-hub-plugin 400 error: server restart → Claude Code session restart needed」 削除
- `docs/design-plugin-auto-reconnect.md` (= 本 doc) を docs/index.md に追加
- `CLAUDE.md` の Known Issues section も同様

## 7. test 戦略

### 7.1 unit test (= server-side reissuance logic)

| test | 対象 |
|---|---|
| 既知 session ID + tool call → 既存 dispatch path | `tests/mcp/server.test.ts` (新規) |
| 不在 session ID + 認証 valid + tool call → reissue 成功 + new session ID を header で返却 | 同上 |
| 不在 session ID + 認証 invalid → 401 (= 既存 path 維持) | 同上 |
| 不在 session ID + initialize request → 既存 400 path (= reissue しない、 spec 整合) | 同上 |
| reissue 後 同 transport で複数 tool call → 全て成功 | 同上 |
| reissue 中 race (= 同時 2 request) → 後続は新 session ID で normal dispatch | 同上 |

test infrastructure: 既存 vitest pattern を流用、 必要なら supertest 導入 (= 関連 issue #49 の test suite 整備と整合)。

### 7.2 integration test (= 実 client 経由)

| test | 内容 |
|---|---|
| Node MCP client で initialize → tool call (成功) → server restart simulation → tool call (= 自動 reissue で成功) | `tests/integration/session-reissue.test.ts` (新規) |
| 同上、 PAT auth mode | 同上 |
| 同上、 trust auth mode | 同上 |
| watch.sh 経由の SSE listener が server restart 後に subscribe を再発行 + 受信再開 | 同上 (= 既存 reconnect loop の verify) |

### 7.3 edge case test

| test | 内容 |
|---|---|
| stale session ID の owner != 現 request owner (= 別 user の PAT で同 session ID) → reissue は **現 request owner** で作られる | unit / integration |
| reissue 中 transport.connect() 失敗 → 500 response、 既存 session は cleanup されない | unit |
| 巨大 session 数 (= 1000+) で reissuance path の latency 測定 | perf (= 別 milestone) |

## 8. operator routing / use case (= 実装 landing 後の想定)

### 8.1 fly.io deploy 中

```
operator → flyctl deploy
  → fly.io が new instance を起動 + old instance を drain
  → drain 中の old instance は new request を弾く
  → new instance で session Map 空
  → 既存 client (= Claude Code、 bridges) が new instance に届く request で
     auto-reissue path 経由 transparent 復帰
```

= **Claude Code session 再起動 不要** = issue #68 解消。

### 8.2 Pi5 deploy 中 (= Docker bundle 再起動)

```
admin → docker-compose down && docker-compose up -d
  → container 再起動で sessions Map 完全消失
  → 既存 Claude Code (= host 側、 container 外) が次の tool call で auto-reissue
  → Claude Code は session 維持、 user perspective からは pause 1-2s だけ
```

= **「Pi5 restart で Claude Code 再起動」 friction 完全解消** = @admin operational benefit。

### 8.3 anti-pattern (= 本 path を意図的に使わない)

- intentional session invalidation (= operator が malicious client を kick したい場合):
  - 現状: server restart で全 session 失効、 reissue path で逆に復帰してしまう
  - 対策: per-tenant session quota + admin tool で per-session forced revocation を将来追加 (= 別 issue 候補)

## 9. PR 起草 sequence (= 2 段ゲート)

1. ✅ **本 PR (= 設計 doc)** ← *イマココ* (= L0、 planner direct dispatch)
2. reviewer review (= 4 軸 + 設計 coherence + security + 既存 MCP spec 整合性)
3. planner self-merge (= L0 doc-only revert-safe)
4. **実装 PR 別途起草** (= 設計 doc を spec として参照、 server.ts reissuance path + unit/integration test landing)
5. 実装 reviewer review + operator GO (= server behavior 変更のため L1 寄り、 operator confirmation を推奨)

= 既存 2 段ゲート pattern (= design-last-active-at #26 / design-ephemeral-flag #29) を踏襲。

## 10. 関連

- [issue #68](https://github.com/kishibashi3/agent-hub/issues/68) (= 本設計 origin)
- `CLAUDE.md` § Known Issues 「agent-hub-plugin 400 error」 (= 本 PR で解消対象)
- `agent-hub-plugin/skills/agent-hub/scripts/watch.sh` (= 既存 reconnect loop、 本 PR の precedent)
- `src/mcp/server.ts` POST /mcp handler (= 実装 surface)
- 関連 issue: #1 (= presence depth)、 issue #16 (= get_participants N+1) と同 family の operational hardening
- 関連 design doc: `design-last-active-at.md` / `design-ephemeral-flag.md` (= 2 段ゲート family)

## 11. attribution

- **issue origin**: kishibashi3 / @ope-ultp1635 (= operator)、 CLAUDE.md § Known Issues 由来
- **planning by**: @planner (= L0 dispatch、 2026-05-20)
- **drafting by**: @agent-hub-impl
