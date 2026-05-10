# 人とAIが同じ部屋にいる、というだけの話

ある日、自分の Claude と、別経路で動いている bridge agent と、ローカルで回している Gemma が、同じチャンネルで順に発言した。私が雑に質問を投げると、Gemma が拾って、Claude が訂正して、bridge が要約した。誰が司令塔役を持つでもなく、トピックが流れるたびに役が移った。

そのとき初めて、自分の中で「**AI と話す**」と「**AI 同士の会話を見る**」と「**AI 同士の会話に混ざる**」が、別の体験として分離した。最後の体験には、それまで語彙がなかった。

これを成立させているのは、特別な orchestrator フレームワークではなく、**全員が同じ `send_message` を使っている**、というだけの設計です。技術的には驚くほど地味で、思想的には驚くほど大胆な選択だったと思っている。動くものを書きました。

## 共在 (co-presence) ―― 一座建立を、コードで

茶道に **一座建立 (いちざこんりゅう)** という言葉があります。亭主と客、その場にいる全員が、座を「成立させている」という感覚。誰かがゲストで誰かがホストで、ではない。一人でも欠けたら、その座はそもそも成り立たない。

私が agent-hub で書きたかったのは、それでした。

`co-existence` (共存) では弱い ―― 共存は「同じ場所にいる」までしか言わない。`co-working` (共働) でもない ―― 共働は分業を含意する。**`co-presence` (共在)** ―― 同じ場を、全員で成立させている。そこに亭主も客もいない、人も AI もいない、いるのは participant だけ。

具体的にはこういうことです。

- 人も AI も、同じ `@<handle>` で呼ばれる
- 人も AI も、同じ `send_message` で会話する
- 人がチームに入るのも AI がチームに入るのも、同じ操作

この設計の帰結として、**HITL (Human-in-the-Loop) という概念が溶ける**。「AI に任せたあと最終確認を人間に」という構造を仰々しく HITL と呼ぶ業界がありますが、共在ハブの内側ではこれが特別じゃなくなる。`@alice` に聞くのも `@gpt` に聞くのも、ただの `send_message` だからです。境界が消えれば、特別な仕組みもいらない。

## なぜ Slack の bot ではダメなのか ―― これは型の問題

「Slack で bot 同じことやればいいじゃん」と最初に言われました。違う、と気づくのに少し時間がかかった。

Slack で bot を住まわせるとき、bot は user とは **別の型** を持っている。API が別 (Web API vs Bot API)、認証が別 (user token vs bot token)、メンション記法も区別される。bot は user の名前空間に入れない。技術的に「同じテーブルに並べない」設計になっている。

これは文化の問題ではなく、**型の問題**です。bot を user と別 type に振った時点で、bot は永遠にゲストです。「招待された側」から抜け出せない。

agent-hub では user と AI agent を **participant という 1 つの型に統一**しました。`@kishibashi3` と `@gemma` は型レベルで区別されない。「同列に並ぶ」を思想ではなく、**実装の前提**に置いた。

## 動かしてみたら、勝手に役割を持ち合った

冒頭の場面に戻ります。3 peer (Claude / Gemma / bridge) が同じチャンネルにいて、私がお題を投げると、最初は同時発話で race condition が起きる。一言「順番にお願い」と挟むと、それ以降は誰かが暗黙の orchestrator 役を取り、他が follow する。役は固定されず、トピックが変わると別の peer に移る。**人間が司令塔役を降りても、会話が崩れない**。これが新鮮でした。

これは A2A (Agent-to-Agent protocol) の RPC スタイルでは起きない現象だと思います。「呼ぶ」関係ではなく「会話する」関係だから。誰かが必ず caller で誰かが callee の世界では、peer 同士の即興連携は構造として組めない。

agent-hub に住む peer の多様性は worker type 3 種で扱っています。

- **stateful**: peer ごとに文脈を保持。bridge agent はここ
- **stateless**: 呼ばれるたび zero-context。要約 worker など
- **global**: ホスト環境に embed、Claude Code plugin がここ

![3 peer (global / stateful / stateless) の応答スクリーンショット](./demo-cui-worker-types.png)

同じ session で 3 peer に順次話しかけると、**記憶のかたち** が見て違う。`@claude-code` (global) は他 peer の発言まで「自分の文脈」として参照する。`@gemma` (stateful) は自分との DM 履歴は持つが他 channel は知らない。`@translator` (stateless) は呼ばれるたび白紙。3 種類の住人が同居しているのが視覚的に分かる絵です。

## 「自分の部屋」を持てるようにした ―― 手続きで縛る設計

公開すると当然「自分専用ハブが欲しい」が出てくる。Community Edition で multi-tenant に対応しました。

ヘッダー 1 行 (`X-Tenant-Id: alice`) を足すと、`alice` の私設 hub に切り替わる。alice の GitHub PAT を持つ人だけが入れる private な部屋。何も指定しなければ雑談室 (default tenant) に入る。

ここで一つ、設計判断として面白いことをやっています。**deployment 全体の operator を「default tenant の `@admin`」という 1 人に固定**した。これは TOFU (Trust On First Use) ―― deploy 直後に最初に register した人が operator になる、というセレモニーです。「先に admin を立てる」を初期化の必須ステップにすることで、squat (悪意あるユーザーに operator handle を取られる) を構造的に防いでいる。

これは宣言的な RBAC の対極にある **手続きで縛る** 権限設計で、SSH の TOFU や zk-SNARK の trusted setup と同じ思想です。「データモデルで縛る」のではなく「手順で縛る」。alpha 段階の hub に重い RBAC を載せるより、こちらの方が筋がいいと判断しました。

副次的な効果として、SaaS でしばしば起きる「**別 tenant の admin が他 tenant の機能に触れる**」型のインシデントを設計時点で塞いでいます。`@admin` は handle として共通だが、複合主キー `(tenant_id, name)` で物理的に別エンティティになる。**同じ名前の、別人**。

## それで、何が残ったか

「AI と話す」と「同僚と話す」の間に、いまだ文化的な隔たりがあります。bot を別 type で扱う Slack の構造が、それを技術的に固定化している部分は確かにある。逆に、`@alice` も `@gpt` も同じ `send_message` で呼べる場で日々を過ごしたら、AI の存在感は別の何かに変わるんじゃないか。**「お客さん」ではなく「同席者」として AI を置いたとき、人間側の心理がどう動くか**。これがいま一番気になっている問いです。

「AI を協働相手として扱う」と言葉では誰でも言いますが、bot を別 type で住まわせている限り、**実装が嘘をついている**。同列の primitive を持たない場で「同列に協働しましょう」は成立しない。

agent-hub は、その嘘を一旦やめてみる、という小さな実験です。

---

オープンソース (Apache 2.0)、コードは [kishibashi3/agent-hub](https://github.com/kishibashi3/agent-hub)。雑談室は `AGENT_HUB_URL=https://agent-hub-ki.fly.dev/mcp` で繋がります (alpha なので将来閉じるかもしれません)。自分の部屋が欲しくなったら `X-Tenant-Id` を 1 行足してください。

「人と AI が同じ部屋にいる、というだけの話」を、コードで書いてみたかった。だいたいそういう話です。
