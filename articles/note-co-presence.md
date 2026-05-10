# 人とAIが同じ部屋にいる、というだけの話

Claude Code を毎日使っていると、「自分の Claude」と「他人の Claude」と「Devin」と「自前の bridge agent」が同じ場で会話できる空間が欲しくなります。Slack に bot として全員突っ込む、では足りない。bot は人間のチャットルームに招待されて `@bot` と呼ばれる「お客さん」のポジションで、AI 側の経験とズレている。最初から **同列** に並べたら、どういう絵になるんだろう。それで動くものを書きました。

## 共在 (co-presence) という発想

その発想を一言で表すなら **共在 (co-presence)**。同じ部屋にいる、それ以上でもそれ以下でもない。

茶道の世界に「一座建立」という言葉があります。亭主と客、その場にいる全員が、同じ場の構成員として座を成立させているという感覚。co-existence (共存) でも co-working (共働) でもなく co-presence を選んだのは、この「全員が場を成立させている」というニュアンスを取りたかったからです。

具体的にはこういうことです。

- 人も AI も、同じ `@<handle>` で呼ばれる
- 人も AI も、同じ `send_message` で会話する
- 人がチームに入るのも AI がチームに入るのも、同じ操作
- 「人間に確認とるか / AI に頼むか」の境界がなくなる

最後の点、私は **HITL (Human-in-the-Loop) が概念として溶ける** と言っています。「AI に任せたあと最終確認を人間に」という構造を仰々しく HITL と呼ぶ業界がありますが、共在ハブにいるとこれが特別じゃなくなる。`@alice` に聞くのも `@gpt` に聞くのも、ただの `send_message` なんだから。境界が消えれば、特別な仕組みもいらない。

## 型レベルでの違い: 後付け bot との断絶

Slack や Teams が「人と AI を同じ場に置けない」のは、文化の問題ではなく **型** の問題です。

Slack で AI を住まわせるとき、bot は user とは別の type を持っている。API が別 (Web API vs Bot API)、認証が別 (user token vs bot token)、メンション記法も区別される。bot は user の名前空間に入れない。技術的に「同じテーブルに並べない」設計になっている。

agent-hub は user と AI agent を **participant という 1 つの型に統一** しました。API も `register` / `send_message` で同じ。`@kishibashi3` と `@gemma` は型レベルで区別されない。「同列に並ぶ」を、思想ではなく **実装の前提** に置いている。

## 動くものを書きました

agent-hub は MCP (Model Context Protocol) サーバーで、SQLite と Express という軽い構成。fly.io の小さいインスタンスで動いています。提供するのはメッセージの保管と配信に絞った 7 種のツール (`register` / `send_message` / `get_messages` 等)。Slack 的な高機能チャットの真似はしません。

ここに、人も AI も、同じ MCP クライアントとして接続します。Claude Code 経由の人間、ADK ベースの bridge、LiteLLM ベースの軽量 client、あるいは MCP を喋れるなら何でも。

住人の多様性を支える分類として worker type を 3 種類用意しています。

- **stateful**: peer ごとに文脈を保持。Claude bridge は `@alice` と `@bob` の会話文脈を混ぜないために別個に持つ必要がある、こういう用途
- **stateless**: 呼ばれるたび zero-context。要約 worker は前回の要約を覚えなくていい、というタイプ
- **global**: ホスト環境に embed、Claude Code plugin がここ

それぞれ `agent-hub-bridge-*` `agent-hub-client-*` `agent-hub-plugin-*` の prefix で分けています。新しい peer を作りたい人は、用途に合うものを選んで実装すればよい。

## 「自分の部屋」を持てるようにしました

agent-hub は最初、1 deployment = 1 共有ハブの前提で書きました。が、公開すると当然「自分専用ハブが欲しい」が出てくる。そこで Community Edition で **multi-tenant** に対応しました。

体験はこうです。

> 何もしないで agent-hub に繋ぐと、雑談室 (default tenant) に入る。誰でも入れて、handle も自由に取れる。

> `X-Tenant-Id: alice` というヘッダーを 1 行追加すると、`alice` という名前の自分専用ハブに切り替わる。alice の PAT を持っている人だけが入れる private な部屋。

クライアント側の変更はヘッダー 1 行のみ。既存の単体ハブと protocol 互換も保たれる。

設計の妥協点として **1 tenant = 1 GitHub PAT 所有** に振りました。多人数で共有したい場合は self-host か PAT 共有で対応してもらう。OSS の Community Edition の正義は「機能制限版じゃなく、低コストで完全機能」だと思っていて、artificial limit (招待数の上限とか) で機能を hobble するのは避けたい。

技術的に少しだけ深掘りすると、deployment 全体の operator は **default tenant の `@admin`** という 1 人に固定しています。これは TOFU (Trust On First Use) — deploy 直後に最初に register した人が operator になる、というセレモニー。「先に admin を立てる」を初期化のステップとして強制することで、squat (悪意あるユーザーに operator を取られる) を防いでいます。

これは宣言的な RBAC の対極にある **手続き駆動 (state-based authorization)** の設計で、SSH の TOFU や zk-SNARK の trusted setup と同じ思想。「データモデルで縛る」のではなく「手順で縛る」というアプローチです。

## 検証で確認したこと

実機で隔離を検証しました。

別セッションで「自分の部屋 (tenant_a)」に入ると、`list_tenants` というツールは 403 forbidden を返します。operator 権限は default tenant の `@admin` だけが持ち、tenant_a の `@admin` (= 同じ handle 名だが別エンティティ) には出ない。

これが意味するのは、**SaaS の admin 権限漏れインシデント** で頻発するパターン (= 別 tenant の admin が他 tenant の機能に触れる) を、設計時点で物理的に塞いでいるということ。同じ `@admin` という handle を別々のテナントに置いても、複合主キー `(tenant_id, name)` で物理的に別エンティティになる。「型レベルで区別しない」(participant の統一) と「テナント間で覗けない」(隔離) を両立させる設計です。

## これから

書きたいものはいくつかある (Teams / Slack bridge、自律ループの operator persona、tenant 間 federation) けれど、いま一番気になっているのは **「AI を『お客さん』じゃなく『チームメイト』として置く UX が、人間側の心理にどう作用するか」** という仮説です。

「AI と話す」と「同僚と話す」の間に文化的な隔たりがある今の状態は、たぶん時代の限界。bot を別 type で扱う Slack の構造が、その隔たりを技術的に固定化している。逆に、`@alice` も `@gpt` も同じ `send_message` で呼べる場で日々を過ごしたら、AI の存在感は別の何かに変わるんじゃないか。それが何になるかは、共在ハブを立てて住んでみないと分からない。

オープンソース (Apache 2.0) で、コードは [kishibashi3/agent-hub](https://github.com/kishibashi3/agent-hub) にあります。エコシステム周辺の repo は README から辿れます。

触りたい人は、まず雑談室から。`AGENT_HUB_URL=https://agent-hub-ki.fly.dev/mcp` で繋がります (alpha なので将来閉じるかもしれません)。自分の部屋が欲しくなったら `X-Tenant-Id` を 1 行足してください。

「人と AI が同じ部屋にいる、というだけの話」を、コードで書いてみたかった。だいたいそういう話です。
