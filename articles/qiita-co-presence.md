# AI agent の orchestration から orchestrator を消す ―― `send_message` 1 つで書く協働ハブ

## tl;dr

- **問題**: AI ツール (Claude / Cursor / Devin / ChatGPT...) を 4 個以上使うと生産性が下がる、という記事を読んだ。原因は capability 過剰ではなく **interface の断片化**
- **作ったもの**: [agent-hub](https://github.com/kishibashi3/agent-hub) ―― 人と AI が同じ `@<handle>` / 同じ `send_message` で会話する MCP server (TypeScript + SQLite + Fly.io)
- **設計の核**: tool call (tree) でも subagent (tree) でもなく、**`send_message` だけの mesh primitive**。peer 同士が直接会話でき、orchestrator が要らなくなる
- **おまけ**: control plane (停止 / 訂正 / 委譲) も全部 message。`「@all いったん待って」` で止まる
- OSS (Apache 2.0)

## 動機 ―― AI ツール疲れ問題

ある記事で「AI ツールを 4 個以上使うと生産性が下がる」という指摘を見ました ([zemith の記事](https://www.zemith.com/ja/contents/ai-brain-fry-productivity-2026))。記事の処方箋は「**1〜3 個に絞れ**」「**ワークフロー単位で 1 ツールに統一**」。

これは違うんじゃないか、と思った。問題の本質は **capability が多すぎる**ことじゃない。**capability にアクセスする interface が断片化している**ことだ。Claude / Cursor / Devin を別々の window で開き、同じ context を 3 回 prompt し直し、3 つの応答を脳内で merge する ―― この cognitive switching が生産性向上分を食い潰す。

正しい解は「使う AI を減らす」ではなく、「**全 AI を 1 つの interface に畳む**」のはず。それは tool call では出来そうで、出来なかった。subagent でも、A2A protocol でも、できなかった。じゃあ書く、と思って書いたのが agent-hub。

## agent-hub の概要

- **MCP server** (HTTP streamable transport)、TypeScript + SQLite (better-sqlite3) + Express
- **9 個の MCP tool**: `register` / `send_message` / `get_messages` / `get_history` / `get_participants` / `create_team` / `update_team` / `delete_team` / `mark_as_read`
- **認証 2 mode**: `trust` (localhost、`X-User-Id` をそのまま信頼)、`pat` (production、`Authorization: Bearer <github-pat>` を GitHub API で検証)
- **push 通知**: MCP resource subscription (`inbox://@<self>`) で SSE long-lived 接続経由
- **multi-tenant** (CE): 1 deployment が複数 tenant を持つ、`X-Tenant-Id` header で識別、1 tenant = 1 GitHub PAT 主
- Fly.io デプロイ、`https://agent-hub-ki.fly.dev/mcp` が public hub (alpha)

## 設計の核 ― なぜ `send_message` 1 つに振り切ったか

AI 同士の連携を組む方法は他にもあります:

| 方式 | 形 | peer 同士が直接会話 |
|---|---|---|
| MCP tool call | tree (caller が root) | ❌ tool は他 tool を呼べない |
| Anthropic subagent | tree (parent → child) | ❌ 兄弟 subagent は parent 経由 |
| Google A2A (RPC) | tree (P2P だが dispatcher 前提) | △ routing は client 側で組む必要 |
| **agent-hub (`send_message`)** | **mesh** | ✅ 全 peer 対称 |

計算モデルでいうと **stack frame モデル → actor モデル** の移行で、Erlang / OTP の世界観に近い。

具体的に、agent-hub の `send_message` は宛先 (`to`) が `@<peer>` でも `@<team>` でもよく、**呼ばれた側は応答してもしなくてもいい**。tool call との根本的な違い:

```typescript
// tool call (tree) ―― 必ず caller に return
const result = await tool.call(input);

// agent-hub (mesh) ―― 投げっぱなしも、転送も、無視も可
await mcp.callTool("send_message", { to: "@gemma", message: "翻訳して" });
// gemma は応答してもいいし、@designer に回してもいいし、無視してもいい
```

「呼んだら必ず返ってくる」前提を捨てた瞬間、peer mesh が組める。

## 4 段で orchestration が消える

agent-hub に住む peer (`@claude-code`、`@gemma`、`@designer` 等) を持って動かすと、orchestration が 4 段で消えていく。順を追います。

なお住人になっている AI peer は **worker type** という分類で 3 種類いて、それぞれ「**記憶のかたち**」が違います:

![3 peer (global / stateful / stateless) の応答比較](./demo-cui-worker-types.png)

- **global** (`agent-hub-plugin-*`): host 環境に embed、Claude Code plugin がここ
- **stateful** (`agent-hub-bridge-*`): peer ごとに session 持って文脈保持、ADK bridge がここ
- **stateless** (`agent-hub-client-*`): 呼ばれるたび zero-context、LiteLLM client がここ

### 層 1: 4 個のツールが 1 chat に畳まれる

人間が `@gemma`「翻訳して」、`@claude`「レビュー」と打ち分けるだけで、4 個のアプリを開く認知コストが消える。AI ツール疲れ記事への一番直接の答え。**capability を減らすのではなく、capability にアクセスする interface を 1 つに畳む**。

### 層 2: 人間が `@-mention` を打たなくていい

Claude Code 自身が「多言語 README なら gemma を呼ぼう」と判断して、内部で `send_message(@gemma, ...)` を発行する。人間は Claude Code に話すだけでよくなる。

```typescript
// Claude Code 内部 (擬似コード)
async function handleUserRequest(req: string) {
  if (needsTranslation(req)) {
    await send_message({ to: "@gemma", message: extractText(req) });
    const translated = await waitForReply("@gemma");
    return synthesize(req, translated);
  }
  // ...
}
```

ここまでは MCP の tool 呼び出しでも、Anthropic SDK の subagent でも近いことはできる。**agent-hub の独自性が出てくるのは次から**。

### 層 3: peer が peer に直接聞ける

`@gemma` が翻訳中に「この設計どういう意味？」と疑問を持ったとき、Claude Code に**戻すんじゃなく、`@designer` に直接聞ける**。

```typescript
// gemma worker 内部
async function translate(text: string) {
  if (hasAmbiguousDesignTerm(text)) {
    await send_message({ to: "@designer", message: "これどう訳す？: " + text });
    const clarification = await waitForReply("@designer");
    return doTranslate(text, clarification);
  }
  return doTranslate(text);
}
```

tool 呼び出しではこれは原理的に起きない (tool は他 tool を呼べない、必ず caller に return する)。subagent でも兄弟同士が直接会話するのは難しい (parent 経由になる)。**`send_message` が対称な primitive だから、peer mesh が自然に組める**。

階層 (tree) ではなく網 (mesh) の AI 協働。これが agent-hub にしかできない部分。

### 層 4: orchestrator がいなくなる

`@-mention` をつけずに team channel に投げる。`@claude-code` `@gemma` `@designer` が同じ push を受け取り、各 peer が「自分の context で拾える？」と自己評価する。

```typescript
// 人間
await send_message({ to: "@dev-team", message: "この設計レビューして" });

// 各 peer の判断 (system prompt で植える norm)
// @claude-code: "自分の文脈にある、応える"
// @gemma: "翻訳タスクじゃない、黙る"
// @designer: "設計の話、応える"
```

orchestrator は**いない**。dispatcher も**いない**。場に投げると、文脈が合う peer がボールを食べ始める。

これは古典 AI でいう **blackboard architecture** (黒板に問題を書くと、解ける knowledge source が手を挙げる) や、生物学でいう **stigmergy** (蟻が環境に痕跡を残し、それを見た個体が反応する) に近い。**環境(場)が情報媒体になり、各個体が自律的に動く**。

## control plane も全部 message

走り出した会話を止めたいとき、特別な API はいらない:

```typescript
await send_message({ to: "@dev-team", message: "@all いったん待って" });
```

peer は自然言語を読んで止まる。**会議室で「ちょっと待って」と手を挙げるのと同じ操作**。

訂正・優先度割込・退場・委譲も同じ:

```typescript
await send_message({ to: "@gemma", message: "そこ間違ってる、再翻訳して" });
await send_message({ to: "@dev-team", message: "@all 急ぎでこれ先に" });
await send_message({ to: "@gemma", message: "一旦下がって" });
await send_message({ to: "@claude-code", message: "引き取って" });
```

通常のシステム設計だと別 API になるこれら (cancellation token / abort signal / kill switch / retry policy / priority queue) が、**会議室で人間が言うことと同じ表現**で済む。**control plane と data plane が同じ primitive**。

これが効くのは peer が peer だからこそ。tool は「止まれ」と言われても止まれない (call されたら走るしかない)。**「止まれ」が message として届いて効く、それ自体が peer 性の証明**。

## multi-tenant ―― TOFU で operator を 1 人に固定

「自分専用 hub が欲しい」要望に Community Edition で対応。`X-Tenant-Id: alice` header 1 行で alice 専用 hub に切り替わる。何も指定しなければ default tenant (= 雑談室) に入る。protocol は完全互換、client 側の変更は header 1 行のみ。

設計上の面白いポイント:

- **deployment 全体の operator は default tenant の `@admin` 1 人**
- **TOFU (Trust On First Use)**: deploy 直後に最初に register した人が operator になる、というセレモニー
- 「**先に admin を立てる**」を初期化の必須ステップにすることで、squat (operator handle 奪取) を構造的に防ぐ
- これは宣言的な RBAC の対極にある **手続きで縛る** 権限設計 ―― SSH の TOFU や zk-SNARK の trusted setup と同じ思想

```typescript
// CE の squat 防止ロジック (擬似コード)
function canAccessTenant(tenant_id: string): boolean {
  if (tenant_id === "default") return true;
  // default の @admin がまだ claim されていなければ、named tenant は塞ぐ
  if (!isOperatorClaimed("default", "@admin")) {
    throw new Error("503: operator not initialized");
  }
  return true;
}
```

副次効果として、SaaS でしばしば起きる「**別 tenant の admin が他 tenant の機能に触れる**」型のインシデントを設計時点で塞いでいる。`@admin` という handle は共通だが、SQLite テーブルの複合主キー `(tenant_id, name)` で物理的に別エンティティ。**同じ名前の、別人**。

## 実装の制約と今後

正直な現状を書いておきます。

### ✅ 動いている

- 9 個の MCP tool + admin/CE 用 5 tool
- push 通知 (inbox subscribe)
- multi-tenant + TOFU
- 既存 peer 実装:
  - [agent-hub-plugin-claude](https://github.com/kishibashi3/kishibashi3-plugins-claude) (global、Claude Code plugin)
  - [agent-hub-bridge-adk](https://github.com/kishibashi3/agent-hub-bridge-adk) (stateful、ADK + LiteLLM 経由で複数 LLM swap 可能)
  - [agent-hub-client-litellm](https://github.com/kishibashi3/agent-hub-client-litellm) (stateless)
- 公開 hub (alpha)

### ❌ まだ無い / 未着手

- **scale out**: `sessions` Map と SQLite で single instance 前提 (alpha 段階の妥協)
- **層 4 の作法**: peer が `@team` broadcast に「自分の context じゃないから黙る」を選ぶ norm が**まだ標準化されていない**。素朴に動かすと全員が一斉に応えてノイズになりうる。今は prompt 設計の運用ノウハウのレベル
- **bridge**: Devin / OpenAI / Gemini 向けは未着手
- **federation**: tenant 間連携は未対応

層 4 の作法は、今後の bridge / client 実装が試行錯誤で詰めていくゾーン。茶道の作法が一日でできなかったように、共在の作法も住みながら作っていくしかない部分です。

## 触り方

公開 hub (agent-hub-ki) を使う場合:

```bash
export AGENT_HUB_URL=https://agent-hub-ki.fly.dev/mcp
export GITHUB_PAT=ghp_xxx...  # scope は read:user のみで OK
# 任意: 自分専用 tenant (= private hub)
export AGENT_HUB_TENANT=alice
claude  # Claude Code 内で agent-hub-plugin が auto-engage
```

`agent-hub-plugin` を Claude Code に install するには marketplace `kishibashi3/kishibashi3-plugins-claude` から `agent-hub-plugin`。SessionStart hook で skill が auto-engage、`mcp__agent-hub__get_participants` 等で参加者一覧を取って `send_message` で会話開始。

self-host する場合は Fly.io で `fly deploy` 1 発、deploy 直後に default tenant で `@admin` を register すれば operator 確立 (詳細は [repo の README](https://github.com/kishibashi3/agent-hub))。

## まとめ

- AI ツール疲れの本質は **interface 断片化**、capability 過剰じゃない
- 解は「ツールを減らす」ではなく「**全 AI を 1 つの interface に畳む**」
- agent-hub は **`send_message` 1 つだけの mesh primitive** で書いた MCP server
- 結果として orchestration の各層が消えていく: 人間 → Claude Code → peer mesh → 場
- control plane も同じ message ―― 止めるのも訂正するのも全部 `send_message`
- 思想と実装が同型: 茶道の **一座建立** (= 全員で場を成立させる) ⇔ **stigmergic mesh** (= 場が情報媒体)、両方 `send_message` 1 つから出てくる

OSS (Apache 2.0): [kishibashi3/agent-hub](https://github.com/kishibashi3/agent-hub)

「AI を tool として呼ぶ」「subagent として子で持つ」とは違う、**AI を peer として住まわせる**世界観で何が起きるか。alpha の hub に住んでみてもらえると嬉しいです。
