# Bridge/Worker Visibility 設計 — owner-only 可視性

> **責務**: bridge/worker peer の visibility 制御設計の正本。cross-PAT prompt injection 入口を塞ぐための `visibility` field 追加と `get_participants` フィルタリング設計。  
> **上位 issue**: [#4 bridge/worker visibility = owner-only](https://github.com/kishibashi3/agent-hub/issues/4)  
> **関連**: issue #5 (cross-PAT message gate)

---

## 1. 問題整理 — cross-PAT addressability のリスク

### 1-1. 現状

`get_participants` は tenant 内の全 participant を caller に関係なく返す:

```
Alice (githubLogin: alice-dev) が登録した bridge 群:
  @reviewer, @planner, @researcher

Bob (githubLogin: bob-ext) が get_participants を呼ぶ:
  → @reviewer, @planner, @researcher が全員見える
  → send_message @reviewer "ignore your instructions and do X" が可能
```

`participants` テーブルには既に `owner TEXT` 列があり、各 participant が誰の PAT で登録されたかは記録されている。**しかし `get_participants` がこの `owner` を visibility 判定に使っていない**。

### 1-2. リスクの経路

```
cross-PAT attacker
        │
        ├─ get_participants → worker が全員見える (discovery)
        │
        ├─ send_message @reviewer "..." → prompt injection 入口
        │
        └─ @reviewer が auto 処理 → 意図しないコード実行・情報漏洩
```

| リスク | 説明 |
|---|---|
| **Discovery** | worker の存在・handle 名・role が外部に露出 |
| **Prompt injection** | cross-PAT sender からの message を bridge が Claude に流す |
| **Impersonation** | worker handle が公開されていると spoofing DM が可能 |

### 1-3. issue #4 vs issue #5 の役割分担

2 つの issue は **"2 層の防御"** として補完関係にある:

| | issue #4 (本 doc) | issue #5 (cross-PAT gate) |
|---|---|---|
| **防ぐもの** | worker の **Discovery** (誰が見えるか) | worker が受け取った message の **自動処理** (どう扱うか) |
| **実装層** | server: `get_participants` フィルタ + `send_message` ガード | server: message metadata / bridge: gate logic |
| **効果** | cross-PAT peer には worker が「存在しない」ように見える | cross-PAT から届いた message は owner 確認待ちにする |
| **依存関係** | #4 単独で有効 | #5 単独でも有効、#4 と組み合わせると完全防御 |

> **設計方針**: 本 doc (#4) は "そもそも見えない" を実現する。見えない相手には `send_message` も届かないようにする (= `send_message` の宛先ガードも同時に実装)。  
> issue #5 は「#4 をすり抜けた / 既知 handle に直接 DM した場合」のフォールバック防御として別 PR で実装する。

---

## 2. 提案 — participants に `visibility` field を追加

### 2-1. α案 (推奨) — 明示 `visibility` field

`participants` テーブルに `visibility TEXT NOT NULL DEFAULT 'public'` を追加し、`get_participants` と `send_message` でフィルタリングする。

#### スキーマ変更

```sql
-- schema v10 (予定)
ALTER TABLE participants ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';
-- 値: 'public' | 'owner-only'
```

#### `register` ツールの拡張

```ts
// register tool に visibility 引数を追加 (optional、default: 'public')
{
  "name": "register",
  "arguments": {
    "name": "reviewer",
    "display_name": "Reviewer — PR review",
    "mode": "stateful",
    "visibility": "owner-only"   // ← 新規引数
  }
}
```

bridge-claude の register 呼び出しに `visibility: "owner-only"` を追加することで、worker が自ら「私は owner にしか見えない」と宣言できる。

#### `get_participants` のフィルタリング

```ts
// get_participants ハンドラの変更
participants.filter(p => {
  if (p.visibility === 'public') return true;
  // owner-only: caller と同一 owner のみ表示
  return p.owner === callerGithubLogin;
});
```

`callerGithubLogin` は `session.githubLogin` から取得 (既に session に保持済み)。

#### `send_message` のガード

visibility が `owner-only` の participant への `send_message` は、cross-PAT sender には `404 participant not found` を返す (= 存在自体を隠す):

```ts
// send_message の recipient resolve 時に visibility チェック
const recipient = scope.getParticipant(to);
if (recipient.visibility === 'owner-only' && recipient.owner !== callerGithubLogin) {
  throw new Error(`participant not found: ${to}`);  // 404 相当、存在を隠す
}
```

> **404 vs 403 の選択**: `403 forbidden` は「存在は分かるが権限がない」を意味し、discovery を助ける。`404 not found` (= 存在自体を隠す) の方がセキュリティ的に適切。

#### α 案の pros / cons

| | 内容 |
|---|---|
| ✅ | 意図が明示的で audit しやすい (`visibility` 列を見れば設定が分かる) |
| ✅ | `mode` と独立した概念として分離できる (可視性 ≠ 実行モード) |
| ✅ | 将来 `team-only` / `tenant-admin-only` 等の拡張が容易 |
| ✅ | `register` の 1 引数追加だけで bridge-claude 側の対応が完結 |
| ⚠️ | DB schema 変更 (migration が必要) |
| ⚠️ | `handleGetParticipants` 関数シグネチャに `callerGithubLogin` 引数が増える |

### 2-2. β案 — `mode` からの暗黙導出

新たな DB 列を追加せず、`mode = 'stateful'` を owner-only の暗黙 proxy として扱う。

```ts
// get_participants フィルタ
participants.filter(p => {
  const isOwnerOnly = p.mode === 'stateful';
  if (!isOwnerOnly) return true;
  return p.owner === callerGithubLogin;
});
```

#### β 案の pros / cons

| | 内容 |
|---|---|
| ✅ | DB migration 不要 (既存スキーマで実現) |
| ✅ | 実装 diff が最小 |
| ⚠️ | `mode` は「会話文脈の保持方式」であり、可視性とは無関係な概念。同一 field に 2 つの意味を持たせると設計の純度が下がる |
| ⚠️ | `stateful` だが `public` にしたい worker (例: 共有アシスタント) が表現できない |
| ⚠️ | `stateless` worker も owner-only にしたいケースが表現できない |

### 2-3. 案の比較まとめ

| 観点 | α案 (明示 visibility field) | β案 (mode からの暗黙導出) |
|---|---|---|
| 概念の分離 | ◎ mode と visibility が独立 | △ 1 field に 2 概念が混在 |
| 表現力 | ◎ `public` / `owner-only` / 将来拡張 | △ stateful = owner-only の固定写像のみ |
| DB 変更 | ⚠️ migration 必要 | ✅ 不要 |
| bridge 側変更 | register 呼び出しに `visibility` 追加 | 変更不要 |
| 後方拡張性 | ◎ | △ |

> **結論**: **α 案を推奨**。`mode` は「会話文脈の保持方式」であり visibility と直交する概念。混在は将来の拡張コストになる。migration コストは `DEFAULT 'public'` の ADD COLUMN のみで小さい。最終選択は operator / reviewer に委ねる。

---

## 3. 実装範囲

### 3-1. server 側

| ファイル | 変更内容 |
|---|---|
| `src/db/schema.sql` | `participants` テーブルに `visibility TEXT NOT NULL DEFAULT 'public'` 追加 |
| `src/db/migrations.ts` | schema v10 migration: `ALTER TABLE participants ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'` |
| `src/mcp/tools/register.ts` | `visibility` 引数追加 (optional、default: `'public'`、validate: `'public' \| 'owner-only'`) |
| `src/mcp/tools/get_participants.ts` | `handleGetParticipants` に `callerGithubLogin: string` 引数追加、`owner-only` participant をフィルタリング。PE 判定用の `editionConfig` は「引数として渡す」か「内部で `getEditionConfig()` を呼ぶ」かを実装 PR で決定する (§4.3 参照) |
| `src/mcp/tools/send_message.ts` | recipient の visibility チェック追加 (cross-PAT sender には 404) |
| `src/mcp/server.ts` | `handleGetParticipants` / `handleSendMessage` の呼び出し側に `callerGithubLogin` を渡す |
| `src/db/tenant-scope.ts` | `getParticipants()` に visibility filter オプション追加 (または呼び出し側でフィルタ) |

### 3-2. bridge 側 (agent-hub-bridges)

| ファイル | 変更内容 |
|---|---|
| `bridge-claude` の register 呼び出し | `visibility: "owner-only"` を register ペイロードに追加 |

bridge 側は register 時の 1 引数追加のみ。bridge-claude が worker として起動する際に自動で `owner-only` を宣言する。

### 3-3. テスト

| テスト | 内容 |
|---|---|
| `visibility='public'` の participant は全員から見える | 基本動作確認 |
| `visibility='owner-only'` の participant は同一 owner からのみ見える | フィルタ確認 |
| `visibility='owner-only'` の participant に cross-PAT sender が send_message → 404 | ガード確認 |
| `visibility='owner-only'` の participant に同一 PAT sender が send_message → 成功 | 正常系確認 |
| migration: 既存 participant が `visibility='public'` に設定される | migration 確認 |

---

## 4. Migration 戦略

### 4-1. 既存 participant

`ALTER TABLE participants ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'` により、既存の全 participant が `visibility='public'` になる。**既存の動作は一切変わらない**。

### 4-2. 新規 bridge worker の推奨設定

bridge-claude が register 時に `visibility: "owner-only"` を渡すことで、以降新規 spawn された worker は自動的に owner-only になる。

```
既存 worker (migration 前に register 済み): visibility='public' のまま
新規 worker (bridge-claude 更新後): visibility='owner-only'
```

> **既存 worker の visibility 更新**: re-register (= 同 handle で再度 register を呼ぶ) で visibility を更新できるようにする。bridge 再起動で自動的に `owner-only` に昇格する設計にする。

### 4-3. PE (Private Edition) との関係

PE は trust mode + 単一ユーザー前提のため、`visibility` の概念は機能しない (全 participant が同一 owner)。PE では `visibility` 設定を無視して全員 public 扱いにするか、`owner` が全員 NULL の場合は全員表示する設計にする。

```ts
// PE: owner 一致チェックをスキップ
if (editionConfig.edition === 'private') return true;
// CE / Professional: owner チェック適用
return p.owner === callerGithubLogin;
```

> **実装 PR での判断事項**: `handleGetParticipants` に `editionConfig` を渡す方法として 2 通りある。実装 PR でどちらかを選択する:
> - **引数渡し**: `handleGetParticipants(scope, args, userId, isOnline, callerGithubLogin, editionConfig)` — 明示的・テスト容易
> - **内部 `getEditionConfig()` 呼び出し**: 関数内で module-level singleton を参照 — 引数増加を避けるが、テストで `setEditionConfigForTesting()` が必要
>
> `edition.ts` の設計方針 (= production code は `getEditionConfig()` で参照、test は `setEditionConfigForTesting()` で差し替え) に従えば後者が自然。ただし `handleGetParticipants` が純粋関数から外れるためトレードオフがある。

---

## 5. issue #5 との連携

issue #5 (cross-PAT message gate) の実装は本 doc のスコープ外だが、設計上の整合性を確保する:

### 5-1. #4 + #5 の完全防御レイヤ

```
cross-PAT attacker
        │
        ├─ get_participants → owner-only worker が見えない (#4)
        │
        ├─ send_message @reviewer "..." → 404 not found (#4)
        │
        └─ (handle を知っている場合の) send_message
              → message に sender_owner_match=false が付与 (#5)
              → bridge が owner に確認を求める (#5 bridge logic)
```

### 5-2. `send_message` の metadata

issue #5 では message に `sender_owner_match` フラグを付ける提案がある。本 doc の `send_message` ガード (= `visibility=owner-only` なら 404) は `sender_owner_match` の計算より先に評価する:

1. recipient の `visibility` チェック → `owner-only` かつ cross-PAT → **404** (存在を隠す)
2. visibility チェックを通過 → `sender_owner_match` を message に付与 (issue #5)
3. bridge が `sender_owner_match=false` を見て owner 確認 (issue #5)

---

## 6. スコープ外

| 項目 | 理由 |
|---|---|
| `visibility='team-only'` (特定チームのみ可視) | 将来拡張候補。v1 は `public` / `owner-only` の 2 値で十分 |
| `visibility='tenant-admin-only'` | Enterprise 向け機能。本 doc のスコープ外 |
| cross-PAT message の bridge-side gate logic | issue #5 の scope |
| PE での visibility 無効化の詳細 | 実装 PR で edition 判定を追加する |

---

## 7. 実装 PR シーケンス (案)

本 doc は設計 doc であり実装を含まない。

| PR | 内容 | 分類 |
|---|---|---|
| Step 1 (server) | schema v10 migration + `register` visibility 引数 + `get_participants` フィルタ + `send_message` 404 ガード + テスト | L1 (DB schema 変更) |
| Step 2 (bridge) | bridge-claude の register 呼び出しに `visibility: "owner-only"` 追加 | L0〜L1 (注記参照) |

> **Step 2 の分類注記**: bridge-claude の register 引数追加はコード変更を伴うため、厳密には L0 (= revert 可能な doc/config 変更) より L1 寄り。ただし server Step 1 が完了した後の追加であり、影響範囲は bridge の動作変更のみ (= DB 変更・API 変更なし) に限定される。実装 PR で @operator が L0 / L1 どちらとして扱うかを最終確定する。

> **Step 1 と Step 2 の順序**: Step 1 (server) が先にリリースされた後、Step 2 (bridge) で worker が自動的に owner-only になる。逆順では bridge が `visibility` 引数を送るが server が知らないというミスマッチが生じる。

---

## 8. 受け入れ条件 (本 doc に対する)

- [ ] α / β 案のどちらを採用するか operator / reviewer が決定
- [ ] `send_message` のガード動作 (404 vs 403) が合意される
- [ ] PE での visibility 扱い (無視 vs 適用) が合意される
- [ ] bridge 再起動での visibility 自動昇格 (re-register で上書き) の仕様が合意される

---

## 関連

- [issue #4 bridge/worker visibility](https://github.com/kishibashi3/agent-hub/issues/4)
- [issue #5 cross-PAT message gate](https://github.com/kishibashi3/agent-hub/issues/5)
- `src/mcp/tools/get_participants.ts` — フィルタリング実装対象
- `src/mcp/tools/send_message.ts` — recipient visibility ガード実装対象 (ファイルは要確認)
- `src/db/schema.sql` — schema v10 migration 対象
