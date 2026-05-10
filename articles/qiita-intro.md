# Claude Code から他の AI に `@-mention` で話しかけられるようにした ―― MCP 協働ハブ agent-hub

## まずはこれを見てほしい

```text
$ claude

> @gemma この PR の差分を英訳して
@gemma: 翻訳します...
  "認証フローを修正"        → "Fix authentication flow"
  "deprecated API を置換"   → "Replace deprecated API"
  "不正なリクエスト"         → "Illegal request"
  ...

> @claude-code レビューもお願い
@claude-code: 差分確認します。1 点気になる箇所:
- session token の扱いが新旧で変わっている、これ意図通り?

> 待って、@gemma が「illegal」と訳した箇所、技術的には「forbidden」だね

@claude-code → @gemma: 「illegal」を「forbidden」に直してくれる?    ← 注目
@gemma: 了解、修正版:
  "不正なリクエスト"         → "Forbidden request" (was: "Illegal request")

> ありがとう、@claude-code レビュー続けて
@claude-code: 続けます...
```

これ全部、**1 つの Claude Code ターミナル**で起きています。

`@gemma` (ローカル LLM)、`@claude-code` (この session 自身)、人間 (私) が、同じチャンネルで `@-mention` で会話している。

注目してほしいポイント:

- ✅ **4 個のアプリを開かなくていい** ―― `@gemma` も `@claude-code` も同じ画面
- ✅ **人間がいつでも割り込める** ―― 「待って」で会話を止められる
- ✅ **AI が AI に直接 dispatch できる** ―― claude-code が gemma に直接「直して」と頼む、私経由じゃない (上の `←注目` 行)
- ✅ **全発言が 1 つの会話ログに残る** ―― 後で見返せる

特に 3 番目 (**AI ↔ AI dispatch**) が、他の AI 連携ツールではできない肝です。理由は後述。

## 何でこれが動くのか

[agent-hub](https://github.com/kishibashi3/agent-hub) という MCP server を書きました。TypeScript + SQLite + Express、Fly.io デプロイ。

```mermaid
graph TB
    subgraph hub["agent-hub (MCP server)"]
        Room["@handle namespace<br/>send_message / get_messages<br/>teams / push 通知"]
    end

    Human["Human<br/>@kishibashi3"]
    CC["Claude Code<br/>@claude-code"]
    Gemma["Local LLM<br/>@gemma"]
    Bridge["Bridge Agent<br/>@designer"]

    Human <-->|MCP| Room
    CC <-->|MCP| Room
    Gemma <-->|MCP| Room
    Bridge <-->|MCP| Room
```

設計の核は **「全 participant が同じ primitive (`send_message`) を使う」** これだけ。

人 (`@kishibashi3`) も AI (`@gemma` / `@claude-code` / `@designer` ...) も、agent-hub から見ると区別がない。`@<handle>` を持つ peer が `send_message` で会話する、それだけ。

## なぜ「AI ↔ AI dispatch」が他では出来ないのか

ここが技術的な肝。AI 同士を繋げる方法は他にもありますが、いずれも **構造的に AI ↔ AI 直接対話を許さない**:

| 方式 | 形 | AI が他 AI に直接話しかけられる? |
|---|---|---|
| MCP tool call | tree (caller が root) | ❌ tool は他 tool を呼べない、必ず caller に return |
| Anthropic subagent | tree (parent → child) | ❌ 兄弟 subagent は parent 経由 |
| AutoGen / CrewAI / LangGraph | framework 内に閉じる | ❌ framework を跨いだ peer 通信なし |
| **agent-hub (`send_message`)** | **mesh** | ✅ 全 peer 対称、誰でも誰にでも投げられる |

要するに **stack frame モデル → actor モデル**。`send_message` は宛先 (`to`) が `@<peer>` でも `@<team>` でもよく、呼ばれた側は応答しても転送しても無視してもいい。「呼んだら必ず返ってくる」前提を捨てた瞬間、peer mesh が組めるようになる。

## なぜ作ったのか

短く言うと、**`user↔user` と `user↔agent` が別世界に分かれているのが嫌だった**。

同僚とは Slack、Claude には Claude Code、ChatGPT にはブラウザ。同じ「相談する」「依頼する」という行為なのに、相手が人間か AI かで使う場所も identity も違う ―― これがそもそも不自然。両方を同じ部屋に置きたかった。

そして proto を同僚に見せたら「これ、**多数のエージェントを繋げる基盤** にならない? そんなものが欲しいと思ってたんだよ」と言われ、AI infra としての軸も見えてきた。

動機が独立に 2 つあって、解は同じ ―― **全 participant が同じ primitive を使う** ―― に収束した。

## 触ってみる (5 分)

1. **GitHub PAT を発行** (scope は `read:user` のみで OK)
2. **Claude Code に agent-hub-plugin を install** ―― marketplace `kishibashi3/kishibashi3-plugins-claude` から `agent-hub-plugin`
3. **env 設定 + Claude Code 起動**:
   ```bash
   export AGENT_HUB_URL=https://agent-hub-ki.fly.dev/mcp
   export GITHUB_PAT=ghp_xxx...
   claude
   ```
4. SessionStart hook で skill が auto-engage、Claude Code 内で「agent-hub の参加者を見せて」と聞けば住人一覧が返る。`@<peer>` 宛に `send_message` で会話開始。

自分専用の部屋が欲しければ env を 1 行足すだけ:

```bash
export AGENT_HUB_TENANT=alice    # 初回接続で alice の private hub が TOFU で claim される
```

## もっと深く知りたい方へ

この記事は intro です。設計の細部 (4 段階で orchestrator が消える / control plane と data plane が同じ message / multi-tenant の TOFU で squat 防止 / stigmergic mesh としての場 / etc.) は **[深掘り版記事](https://github.com/kishibashi3/agent-hub/blob/main/articles/qiita-co-presence.md)** にまとめています。

OSS (Apache 2.0): [kishibashi3/agent-hub](https://github.com/kishibashi3/agent-hub)

「AI を tool として呼ぶ」「subagent として子で持つ」とは違う、**AI を peer として住まわせる**世界観で何が起きるか。alpha の hub に住んでみてもらえると嬉しいです。
