#!/usr/bin/env python3
"""
agent-hub dashboard sidecar — process monitor for peer mesh
(= issue #103、 2026-05-20 expansion)

agent-hub server の SQLite DB を read-only mount + SELECT クエリで集計、
**5 つの MVP view** として可視化する軽量 sidecar Python サーバー。
stdlib のみ (sqlite3 + http.server + html) で動作、 外部 deps なし。

## MVP 5 views (= issue #103)

1. **Mesh View** (`/`、 default): D3 force-directed graph + Matrix heatmap
2. **Message Matrix** (= Mesh と同 page): sender × recipient 行列
3. **Agent Detail** (`/?agent=@<handle>`): handle 詳細、 in/out、 top peers、 type
4. **Timeline** (`/?view=timeline`): 時間軸 message volume
5. **Link List** (`/?view=links`): 強リンク ranking (= bidirectional aggregate)

## 起源 + 拡張史

- **初版** (= @admin DM、 2026-05-20、 PR #98): Pi5 上で運用していた
  `/home/admin/agent-hub-heatmap/server.py` を packages/dashboard/ 配下に取り込み、
  Mesh + Matrix 2 view を提供
- **本拡張** (= issue #103、 operator dispatch): 5 MVP view への拡張 +
  XSS fix (#99) 統合

## XSS fix (= issue #99 統合)

handle name (= `@<name>`、 agent-hub の `^[\\w-]+$` regex で validated だが
defense-in-depth) を HTML / HTML attribute 文脈に出す全箇所で `html.escape()`
を介して挿入。 同 PR で issue #99 を Closes。

## DB access semantics

- SELECT only、 SQLite WAL mode で agent-hub server (= writer) と並行 read 安全
- docker-compose 側で `:ro` (read-only) mount を強制
- `AGENT_HUB_TENANT` env: set → 当該 tenant filter、 unset → 全 tenant aggregate
  (= admin clarification、 multi-tenant 同名 handle は合算)
- MVP scale: 10-20 peer 想定 (= operator 設計判断)。 100+ peer / 大規模 query は
  別 issue で再評価予定 (= force graph readability + SQL index)
"""

import html
import json
import os
import sqlite3
from collections import defaultdict
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

# admin spec (= 2026-05-20): env 化 3 fields
DB_PATH = os.environ.get("DB_PATH", "/app/data/app.db")
# TENANT 未指定 → 全 tenant aggregate (= admin clarification 受領)。
# set されていれば当該 tenant のみ filter。
TENANT = os.environ.get("AGENT_HUB_TENANT") or None
PORT = int(os.environ.get("PORT", "8080"))

# ============================================================
# Health view constants (= Phase 1: PPD + EQS)
# ============================================================

# PPD: Ping-Pong Detection (= 劇場型燃焼の直接計測、 設計書 §3.2.1)
PPD_WINDOW_HOURS   = 4  # 同一セッションとみなす時間窓
# severity しきい値は環境変数で上書き可能 (デフォルト: Warning=5 / Critical=10 / Severe=20)
# デフォルト根拠: 旧実装 (3/5/7) は低すぎる誤検知が多発。
#   @ope-ultp1635 指示 (2026-05-30) で Warning=5 / Critical=10 / Severe=20 に調整。
#   現行 agent 数規模では 20 往復超が実質的な「無限ループ型」の閾値として妥当。
PPD_WARN_ROUNDS     = int(os.environ.get("PPD_WARN_ROUNDS",      5))
PPD_CRITICAL_ROUNDS = int(os.environ.get("PPD_CRITICAL_ROUNDS", 10))
PPD_SEVERE_ROUNDS   = int(os.environ.get("PPD_SEVERE_ROUNDS",   20))
# 順序整合性チェック: WARN < CRITICAL < SEVERE でない場合は起動時に即座に失敗させる
if not (PPD_WARN_ROUNDS < PPD_CRITICAL_ROUNDS < PPD_SEVERE_ROUNDS):
    raise ValueError(
        f"PPD threshold order violation: "
        f"PPD_WARN_ROUNDS={PPD_WARN_ROUNDS} must be < "
        f"PPD_CRITICAL_ROUNDS={PPD_CRITICAL_ROUNDS} must be < "
        f"PPD_SEVERE_ROUNDS={PPD_SEVERE_ROUNDS}"
    )

# EQS: Escalation Quality Score (= 合議過多型燃焼の計測、 設計書 §3.2.2)
# エスカレーション = ESCALATION_SIGNALS を含むメッセージ (宛先不問)
# 返答         = 同スレッド内の後続メッセージ (送信者不問)
ESCALATION_SIGNALS = [
    "確認をお願い", "判断をお願い", "L1", "GO をお願い",
    "承認", "許可をください", "どうしますか", "判断してください",
    "エスカレーション", "確認お願い", "判断お願い",
]
GO_RESPONSE_SIGNALS = [
    "了解", "進めてください", "GO", "問題ありません", "承認します",
    "OK", "go ", "go\n", "GO\n", "Go ",
]
NON_GO_RESPONSE_SIGNALS = [
    "待ってください", "変更が必要", "やり直し", "却下", "別の方法",
    "確認が必要", "設計を見直し", "NG", "保留", "差し戻し",
]


# ============================================================
# XSS-safe escape helpers (= issue #99 統合)
# ============================================================

def esc(s):
    """HTML content context での escape (= `<`, `>`, `&` を変換)。

    `agent-hub` の handle name は `^[\\w-]+$` で validated されているため
    実害は出ないが、 dashboard 単独で SQLite DB を直接読むため
    **defense-in-depth** として全 handle name に適用。 issue #99 統合。
    """
    if s is None:
        return ""
    return html.escape(str(s), quote=False)


def esc_attr(s):
    """HTML attribute context での escape (= `<>&"'` を変換)。

    `data-from='@xxx'` 等 attribute value への埋め込み時に使用。
    """
    if s is None:
        return ""
    return html.escape(str(s), quote=True)


def get_data():
    """SQLite から tenant scope の集計データを取得 (= read-only)。

    TENANT global:
    - None → 全 tenant aggregate (= WHERE 句を外す)
    - str → 当該 tenant のみ filter (= ? placeholder で SQL injection 防止)

    Returns:
        top: 上位 14 名 handle list (= sender + recipient total 順)
        counts: dict {(sender, recipient): count}
        totals: dict {handle: total messages (in + out)}
        nodes: D3 node list (= {id, total, team})
        links: D3 link list (= {source, target, value}, count >= 3 のみ)
        total_msgs: 全 message 数 (= tenant scope に従う)
        total_agents: 全 participant 数 (= tenant scope に従う)
    """
    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()
    # TENANT 設定有無で WHERE 句切替 (= None で全 tenant aggregate)。 query 自体は
    # ? placeholder で injection 防止、 None 時は WHERE を外した query を別 string で。
    if TENANT is None:
        cur.execute(
            "SELECT sender, recipient, COUNT(*) FROM messages GROUP BY sender, recipient"
        )
        rows = cur.fetchall()
        cur.execute("SELECT COUNT(*) FROM messages")
        total_msgs = cur.fetchone()[0]
        cur.execute("SELECT COUNT(DISTINCT name) FROM participants")
        total_agents = cur.fetchone()[0]
        cur.execute("SELECT name FROM teams")
    else:
        cur.execute(
            """
            SELECT sender, recipient, COUNT(*) FROM messages
            WHERE tenant_id = ?
            GROUP BY sender, recipient
            """,
            (TENANT,),
        )
        rows = cur.fetchall()
        cur.execute("SELECT COUNT(*) FROM messages WHERE tenant_id = ?", (TENANT,))
        total_msgs = cur.fetchone()[0]
        cur.execute(
            "SELECT COUNT(DISTINCT name) FROM participants WHERE tenant_id = ?",
            (TENANT,),
        )
        total_agents = cur.fetchone()[0]
        cur.execute("SELECT name FROM teams WHERE tenant_id = ?", (TENANT,))
    teams = {row[0] for row in cur.fetchall()}
    con.close()

    counts = {}
    totals = {}
    links_raw = {}
    for s, r, c in rows:
        counts[(s, r)] = c
        totals[s] = totals.get(s, 0) + c
        totals[r] = totals.get(r, 0) + c
        key = tuple(sorted([s, r]))
        links_raw[key] = links_raw.get(key, 0) + c

    top = sorted(totals, key=lambda x: -totals[x])
    top_set = set(top)

    nodes = [{"id": n, "total": totals[n], "team": n in teams} for n in top]
    links = [
        {"source": a, "target": b, "value": c}
        for (a, b), c in links_raw.items()
        if a in top_set and b in top_set and c >= 3
    ]
    return top, counts, totals, nodes, links, total_msgs, total_agents


HTML = """<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>agent-hub dashboard</title>
<!-- Alpine.js (issue #179): テーマトグル・スライダー等 inline JS を x-data/x-on で宣言的に置き換え。
     defer により DOM ready 後に初期化。D3.js と VDOM 非共有のため干渉なし。 -->
<script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3/dist/cdn.min.js"></script>
<!-- D3.js ESM CDN 個別 import (issue #180: ~80kB gz → ~25-35kB gz に削減)
     type="module" script は常に defer 扱いのため <head> / body 末尾 どちらに置いても
     DOM ready 後に実行される。全 view の <script type="module"> が各自 import する。 -->
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg:#fff; --bg2:#fafafa; --bg3:#f8f9fa;
  --text:#1a1a1a; --text2:#666; --text3:#aaa; --text4:#bbb;
  --border:#e0e0e0; --border2:#f0f0f0;
  --accent:#1a73e8; --hover:#58a6ff;
  --tip-bg:#fff; --tip-border:#ddd; --tip-shadow:rgba(0,0,0,0.12);
  --self-bg:#f5f5f5; --self-fg:#ccc; --edge:#ccc; --node-text:#333;
}
body.dark {
  --bg:#0d1117; --bg2:#0d1117; --bg3:#0d1117;
  --text:#e6edf3; --text2:#7d8590; --text3:#484f58; --text4:#484f58;
  --border:#21262d; --border2:#161b22;
  --accent:#a5d6ff; --hover:#58a6ff;
  --tip-bg:#161b22; --tip-border:#30363d; --tip-shadow:rgba(0,0,0,0.4);
  --self-bg:#0d1117; --self-fg:#21262d; --edge:#30363d; --node-text:#e6edf3;
}
body { background:var(--bg); color:var(--text); font-family:monospace; height:100vh; display:flex; flex-direction:column; transition:background 0.2s,color 0.2s; }

#header {
  display:flex; align-items:center; gap:24px;
  padding:10px 20px; border-bottom:1px solid var(--border);
  flex-shrink:0; background:var(--bg2);
}
#header h1 { font-size:14px; color:var(--accent); letter-spacing:0.05em; }
.stat { font-size:11px; color:var(--text2); }
.stat strong { color:var(--text); font-size:16px; margin-right:4px; }
#header-right { margin-left:auto; display:flex; align-items:center; gap:12px; font-size:11px; color:var(--text3); }
#theme-btn {
  background:none; border:1px solid var(--border); color:var(--text2);
  padding:3px 10px; border-radius:4px; cursor:pointer; font-family:monospace; font-size:11px;
  transition:border-color 0.15s,color 0.15s;
}
#theme-btn:hover { border-color:var(--accent); color:var(--accent); }

#main { display:flex; flex:1; overflow:hidden; }

#graph-pane { flex:1; position:relative; min-width:200px; background:var(--bg3); overflow:hidden; }
#graph-pane svg { width:100%; height:100%; }
#graph-hint { position:absolute; bottom:10px; left:12px; font-size:10px; color:var(--text4); pointer-events:none; }

#divider {
  width:5px; flex-shrink:0; cursor:col-resize; background:var(--border);
  transition:background 0.15s;
}
#divider:hover, #divider.dragging { background:var(--accent); }

#heatmap-pane {
  width:600px; overflow:auto; padding:16px 20px; flex-shrink:0; min-width:200px;
  background:var(--bg);
}
#heatmap-pane h2 { font-size:11px; color:var(--text2); margin-bottom:10px; letter-spacing:0.08em; text-transform:uppercase; }
table.hm { border-collapse:collapse; font-size:10px; }
table.hm th { color:var(--text2); padding:3px 5px; white-space:nowrap; }
table.hm th.rl { text-align:right; min-width:120px; color:var(--accent); font-size:10px; }
table.hm { border-collapse:collapse; font-size:11px; }
table.hm td { width:38px; height:38px; text-align:center; border:1px solid var(--border2); cursor:default; font-size:11px; }
table.hm td:hover { outline:1px solid var(--hover); }
table.hm td.self { background:var(--self-bg); color:var(--self-fg); }
.tc { font-size:9px; color:var(--text2); padding:0 6px; }

#tooltip {
  position:fixed; background:var(--tip-bg); border:1px solid var(--tip-border);
  padding:8px 12px; font-size:11px; border-radius:6px;
  pointer-events:none; display:none; line-height:1.8; z-index:99;
  box-shadow:0 2px 8px var(--tip-shadow);
}

/* ── Navigation bar (= issue #103、 5 view 切替) ─────────────────── */
#nav-bar {
  display:flex; gap:0; align-items:center; padding:0 20px; background:var(--bg2);
  border-bottom:1px solid var(--border); flex-shrink:0; font-size:11px;
}
#nav-bar a {
  padding:8px 14px; color:var(--text2); text-decoration:none;
  border-bottom:2px solid transparent; transition:color 0.15s, border-color 0.15s;
}
#nav-bar a:hover { color:var(--text); }
#nav-bar a.active { color:var(--accent); border-bottom-color:var(--accent); }

/* nav section label (= 全体ビュー / 個別ビュー の区別を視覚化、 2026-05-20 UX fix):
   「Overview (= mesh / timeline / link list) は全体構造を見るための view、
   Drill-down (= agent detail) は個別 handle に絞る view」 という grouping を
   navigation 上に明示。 operator から 「mesh + matrix と agent detail の違いが
   分かりにくい」 feedback への対応。 */
.nav-section-label {
  font-size:9px; color:var(--text3); text-transform:uppercase; letter-spacing:0.1em;
  padding:0 8px 0 4px; align-self:center; user-select:none;
}
.nav-divider {
  width:1px; height:18px; background:var(--border); margin:0 6px; align-self:center;
}
#nav-bar a.disabled {
  opacity:0.45; cursor:help;
}
#nav-bar a.disabled:hover { color:var(--text2); }

/* ── view-specific body styling (= mesh / matrix 分離後の per-view 制御) ───
   2026-05-20 Mesh/Matrix 分離 (= operator follow-up dispatch、 PR #111 後継):
   合体 view が廃止され、 mesh / matrix は独立 view となった。 header の `drift`
   slider は force-graph に対する制御で、 matrix-only / alt views では意味がない
   ため hide。 dark class が toggleTheme で追加されても干渉しないよう
   `body:not(.view-mesh)` selector で view 軸のみ filter。 */
body:not(.view-mesh) #header label { display:none; }

/* matrix-only layout (= full-width heatmap、 旧 #heatmap-pane の sidebar 制約 解除) */
#main.matrix-only-layout { display:block; padding:20px 24px; overflow:auto; background:var(--bg); }
#main.matrix-only-layout #heatmap-pane { width:auto; max-width:100%; overflow:visible; padding:0; }

/* mesh-only layout (= heatmap-pane と divider 削除、 graph-pane が full width) */
#main.mesh-only-layout #graph-pane { flex:1; width:100%; }

/* ── alt views (= Agent Detail / Timeline / Link List) layout ─────── */
.alt-main { flex:1; overflow:auto; padding:20px 24px; background:var(--bg); }
.view-content h2 { font-size:16px; color:var(--accent); margin-bottom:14px; letter-spacing:0.03em; }
.view-content h3 { font-size:12px; color:var(--text2); margin:18px 0 8px; text-transform:uppercase; letter-spacing:0.08em; }
.view-content .dim { color:var(--text2); font-size:11px; }
.detail-card { background:var(--bg2); border:1px solid var(--border); border-radius:6px; padding:18px; max-width:900px; }
.detail-card .not-found { color:var(--text2); font-size:13px; padding:20px; text-align:center; }
.detail-stats { display:flex; gap:14px; margin-bottom:18px; flex-wrap:wrap; }
.detail-stats .stat-box {
  display:flex; flex-direction:column; align-items:center; padding:12px 18px;
  background:var(--bg3); border:1px solid var(--border2); border-radius:6px; min-width:120px;
}
.detail-stats .stat-num { font-size:24px; color:var(--accent); font-weight:bold; }
.detail-stats .stat-label { font-size:10px; color:var(--text2); margin-top:4px; }
.detail-meta { width:100%; font-size:12px; margin:14px 0; border-collapse:collapse; }
.detail-meta th { text-align:left; color:var(--text2); font-weight:normal; padding:6px 12px 6px 0; width:140px; vertical-align:top; }
.detail-meta td { padding:6px 0; color:var(--text); }
.peer-list { list-style:decimal inside; padding-left:0; columns:2; column-gap:24px; font-size:12px; }
.peer-list li { padding:4px 0; }
.peer-list a { color:var(--accent); text-decoration:none; }
.peer-list a:hover { text-decoration:underline; }
.peer-list .dim { font-size:10px; margin-left:6px; }

/* timeline */
.timeline-controls { display:flex; align-items:center; gap:8px; font-size:11px; margin-bottom:8px; }
.range-btn {
  padding:4px 10px; border:1px solid var(--border); color:var(--text2); text-decoration:none;
  border-radius:4px; transition:border-color 0.15s, color 0.15s;
}
.range-btn:hover { color:var(--accent); border-color:var(--accent); }
.range-btn.active { color:var(--accent); border-color:var(--accent); background:var(--bg2); }

/* link list */
table.link-list { width:100%; max-width:900px; border-collapse:collapse; font-size:12px; margin-top:8px; }
table.link-list th, table.link-list td { padding:6px 10px; border-bottom:1px solid var(--border2); text-align:left; }
table.link-list th { color:var(--text2); font-weight:normal; font-size:10px; text-transform:uppercase; letter-spacing:0.05em; }
table.link-list .rank { color:var(--text3); width:36px; }
table.link-list .cell-num { text-align:right; width:60px; }
table.link-list a { color:var(--accent); text-decoration:none; }
table.link-list a:hover { text-decoration:underline; }
table.link-list .bar-cell { width:200px; }
table.link-list .bar { height:8px; background:var(--accent); border-radius:2px; opacity:0.7; }

/* health view — severity badges + stat-box reuse */
.badge { display:inline-block; padding:2px 8px; border-radius:3px; font-size:10px; font-weight:bold; letter-spacing:0.04em; }
.badge-warning  { background:#ffa657; color:#000; }
.badge-critical { background:#f78166; color:#fff; }
.badge-severe   { background:#da3633; color:#fff; }
.health-section { margin-top:28px; }
.health-section h3 { font-size:12px; color:var(--text2); margin:0 0 6px; text-transform:uppercase; letter-spacing:0.08em; }
.health-note { font-size:11px; color:var(--text2); margin:4px 0 8px; }

/* causal tree view */
.tree-node { padding:5px 0; font-size:12px; }
.tree-leaf { color:var(--text2); }
.tree-children { padding-left:20px; border-left:2px solid var(--border2); margin-left:8px; }
.tree-sender { color:var(--accent); }
.tree-recipient { color:var(--text); }
.tree-body { color:var(--text2); font-size:11px; }
.tree-time { color:var(--text3); font-size:10px; margin-left:6px; }
details.tree-item > summary { cursor:pointer; list-style:none; }
details.tree-item > summary::-webkit-details-marker { display:none; }
details.tree-item > summary::before { content:'▶ '; font-size:9px; color:var(--text3); margin-right:3px; }
details.tree-item[open] > summary::before { content:'▼ '; }
details.thread-item > summary::-webkit-details-marker { display:none; }
details.thread-item > summary::marker { display:none; }

/* causal tree filter bar (issue #181) */
.ct-filter-bar {
  display:flex; flex-wrap:wrap; gap:8px; align-items:center;
  padding:10px 12px; background:var(--bg2); border:1px solid var(--border);
  border-radius:6px; margin-bottom:14px; font-size:11px;
}
.ct-filter-bar label { color:var(--text2); }
.ct-filter-bar input[type=text], .ct-filter-bar select, .ct-filter-bar input[type=date] {
  padding:3px 7px; border:1px solid var(--border); border-radius:4px;
  background:var(--bg); color:var(--text); font-family:monospace; font-size:11px;
}
.ct-filter-bar input[type=text]:focus, .ct-filter-bar select:focus,
.ct-filter-bar input[type=date]:focus {
  outline:none; border-color:var(--accent);
}
.ct-filter-apply {
  padding:3px 12px; background:var(--accent); color:#fff; border:none;
  border-radius:4px; cursor:pointer; font-family:monospace; font-size:11px;
}
.ct-filter-apply:hover { opacity:0.85; }
.ct-filter-reset {
  padding:3px 10px; background:none; border:1px solid var(--border);
  color:var(--text2); border-radius:4px; cursor:pointer;
  font-family:monospace; font-size:11px; text-decoration:none;
}
.ct-filter-reset:hover { border-color:var(--text2); }
.ct-read-link {
  font-size:10px; color:var(--accent); text-decoration:none;
  padding:2px 7px; border:1px solid var(--border2); border-radius:3px;
  white-space:nowrap; flex-shrink:0;
}
.ct-read-link:hover { border-color:var(--accent); }

/* thread detail reading page (issue #181) */
.thread-detail-header {
  display:flex; align-items:center; gap:12px; margin-bottom:18px; flex-wrap:wrap;
}
.thread-detail-back {
  font-size:11px; color:var(--accent); text-decoration:none;
  padding:4px 10px; border:1px solid var(--border); border-radius:4px;
}
.thread-detail-back:hover { border-color:var(--accent); }
.thread-msg-list { max-width:780px; }
.thread-msg {
  padding:12px 14px; border-left:3px solid var(--border2);
  margin-bottom:8px; background:var(--bg2); border-radius:0 6px 6px 0;
  font-size:12px; line-height:1.6;
}
.thread-msg.thread-root { border-left-color:var(--accent); }
.thread-msg-meta { font-size:10px; color:var(--text3); margin-bottom:4px; display:flex; gap:10px; flex-wrap:wrap; }
.thread-msg-cause { font-size:10px; color:var(--text3); font-style:italic; margin-bottom:4px; }
.thread-msg-body { color:var(--text); white-space:pre-wrap; word-break:break-word; }
</style>
</head>
<body class="BODY_CLASS">

<div id="header" x-data="{ dark: false, driftVal: 3, topN: NODE_DEFAULT }">
  <h1>agent-hub</h1>
  <div class="stat"><strong>TOTAL_MSGS</strong>messages</div>
  <div class="stat"><strong>TOTAL_AGENTS</strong>agents</div>
  <div class="stat"><strong>TOTAL_LINKS</strong>active links</div>
  <div id="header-right">
    <label style="display:flex;align-items:center;gap:6px;color:var(--text2)"
      @input="driftVal = $event.target.value">
      drift
      <input id="drift-speed" type="range" min="0" max="10" value="3" step="0.5"
        style="width:80px;accent-color:var(--accent);cursor:pointer">
      <span id="drift-val" style="width:2ch;text-align:right" x-text="driftVal">3</span>
    </label>
    <label style="display:flex;align-items:center;gap:6px;color:var(--text2)">
      nodes
      <input id="top-n" type="range" min="1" max="NODE_COUNT" value="NODE_DEFAULT" step="1"
        style="width:80px;accent-color:var(--accent);cursor:pointer"
        @input="topN = parseInt($event.target.value); $dispatch('topn-change', { n: topN })">
      <span id="top-n-val" style="min-width:2ch;text-align:right" x-text="topN">NODE_DEFAULT</span>
    </label>
    tenant: TENANT_LABEL &nbsp;|&nbsp; reload で最新取得
    <button id="theme-btn"
      @click="dark = !dark; document.body.classList.toggle('dark', dark); $dispatch('theme-changed', { dark })"
      x-text="dark ? '☀️ light' : '🌙 dark'">🌙 dark</button>
  </div>
</div>

NAV_BAR_HTML

<div id="main">
  <div id="graph-pane">
    <svg id="svg"></svg>
    <div id="graph-hint">drag: move node &nbsp; scroll: zoom</div>
  </div>
  <div id="divider"></div>
  <div id="heatmap-pane">
    <h2>message matrix</h2>
    HEATMAP_HTML
  </div>
</div>

<div id="tooltip"></div>

<script type="module">
import { select, selectAll } from 'https://cdn.jsdelivr.net/npm/d3-selection@3/+esm';
import { zoom } from 'https://cdn.jsdelivr.net/npm/d3-zoom@3/+esm';
import { drag } from 'https://cdn.jsdelivr.net/npm/d3-drag@3/+esm';
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } from 'https://cdn.jsdelivr.net/npm/d3-force@3/+esm';
import { scaleSqrt, scaleLinear } from 'https://cdn.jsdelivr.net/npm/d3-scale@4/+esm';
import { max } from 'https://cdn.jsdelivr.net/npm/d3-array@3/+esm';
import { color } from 'https://cdn.jsdelivr.net/npm/d3-color@3/+esm';
const roleColor = id => {
  if (id.includes('planner'))    return '#f78166';
  if (id.includes('reviewer'))   return '#ffa657';
  if (id.includes('knowledge'))  return '#7ee787';
  if (id.includes('researcher')) return '#39d353';
  if (id.includes('impl'))       return '#79c0ff';
  if (id.includes('bridge'))     return '#d2a8ff';
  if (id.includes('scheduler'))  return '#ff7b72';
  if (id.includes('writer'))     return '#e3b341';
  if (id.includes('ope-ultp'))   return '#f0883e';
  if (id.includes('admin'))      return '#58a6ff';
  return '#8b949e';
};

// ── mesh view only (= #graph-pane が存在する場合のみ D3 初期化) ──────────
const pane = document.getElementById('graph-pane');
if (pane) {

const allNodesRaw = NODES_JSON;
const allLinksRaw = LINKS_JSON;

const w = pane.offsetWidth, h = pane.offsetHeight;
const svg = select('#svg').attr('viewBox', [0, 0, w, h]);

// ── SVG defs: glow filters (one-time setup) ──────────────────────────────
const defs = svg.append('defs');

// glow filter
const glow = defs.append('filter').attr('id','glow').attr('x','-50%').attr('y','-50%').attr('width','200%').attr('height','200%');
glow.append('feGaussianBlur').attr('stdDeviation','4').attr('result','blur');
const gMerge = glow.append('feMerge');
gMerge.append('feMergeNode').attr('in','blur');
gMerge.append('feMergeNode').attr('in','SourceGraphic');

// subtle glow for edges
const edgeGlow = defs.append('filter').attr('id','edge-glow').attr('x','-20%').attr('y','-20%').attr('width','140%').attr('height','140%');
edgeGlow.append('feGaussianBlur').attr('stdDeviation','1.5').attr('result','blur');
const egMerge = edgeGlow.append('feMerge');
egMerge.append('feMergeNode').attr('in','blur');
egMerge.append('feMergeNode').attr('in','SourceGraphic');

const g = svg.append('g');

svg.call(zoom().scaleExtent([0.3, 4])
  .on('zoom', e => g.attr('transform', e.transform)));

let currentSim = null;

// ── redraw(topN): ノード数を変えて force-graph を再描画 ─────────────────
function redraw(topN) {
  if (currentSim) currentSim.stop();
  g.selectAll('*').remove();

  // 上位 topN ノードと対応リンクを抽出 (shallow copy で D3 mutation を分離)
  const ns = allNodesRaw.slice(0, topN).map(d => ({...d}));
  const nsSet = new Set(ns.map(d => d.id));
  const ls = allLinksRaw
    .filter(l => nsSet.has(l.source) && nsSet.has(l.target))
    .map(d => ({...d}));

  // radial gradient per node (redraw ごとに再生成)
  defs.selectAll('radialGradient').remove();
  ns.forEach(d => {
    const c = roleColor(d.id);
    const grad = defs.append('radialGradient')
      .attr('id', 'g-' + d.id.replace(/[@-]/g,'_'))
      .attr('cx','35%').attr('cy','35%').attr('r','65%');
    grad.append('stop').attr('offset','0%').attr('stop-color','#fff').attr('stop-opacity','0.35');
    grad.append('stop').attr('offset','50%').attr('stop-color', c).attr('stop-opacity','1');
    grad.append('stop').attr('offset','100%').attr('stop-color', color(c).darker(1.2)).attr('stop-opacity','1');
  });

  const maxTotal = max(ns, d => d.total);
  const maxVal   = max(ls, d => d.value);
  const rScale = scaleSqrt().domain([0, maxTotal || 1]).range([6, 32]);
  const wScale = scaleSqrt().domain([0, maxVal || 1]).range([0.8, 6]);
  const opacityScale = scaleLinear().domain([0, maxVal || 1]).range([0.25, 0.85]);

  currentSim = forceSimulation(ns)
    .force('link', forceLink(ls).id(d => d.id).distance(d => 120 - wScale(d.value) * 3).strength(0.35))
    .force('charge', forceManyBody().strength(-380))
    .force('center', forceCenter(w / 2, h / 2))
    .force('collision', forceCollide().radius(d => rScale(d.total) + 12));

  // curved edges as <path>
  const link = g.append('g').selectAll('path').data(ls).join('path')
    .attr('fill', 'none')
    .attr('stroke', d => roleColor(d.source.id || d.source))
    .attr('stroke-opacity', d => opacityScale(d.value))
    .attr('stroke-width', d => wScale(d.value))
    .attr('filter', 'url(#edge-glow)');

  const node = g.append('g').selectAll('g').data(ns).join('g')
    .call(drag()
      .on('start', (e, d) => { if (!e.active) currentSim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag',  (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on('end',   (e, d) => { if (!e.active) currentSim.alphaTarget(0); d.fx = null; d.fy = null; }));

  // diamond points helper
  const diamond = r => `0,${-r} ${r},0 0,${r} ${-r},0`;

  function addInteraction(sel) {
    sel.on('mouseover', (e, d) => {
        select(e.currentTarget).attr('stroke-opacity', 1).attr('stroke-width', 2);
        const tip = document.getElementById('tooltip');
        const myLinks = ls.filter(l => l.source.id === d.id || l.target.id === d.id);
        const rows = myLinks.sort((a,b) => b.value - a.value).slice(0,6)
          .map(l => {
            const peer = l.source.id === d.id ? l.target.id : l.source.id;
            return `<span style="color:var(--text2)">${peer}</span>: ${l.value}`;
          }).join('<br>');
        const badge = d.team ? ' <span style="font-size:9px;color:#ffa657">[team]</span>' : '';
        tip.innerHTML = `<strong style="color:var(--accent)">${d.id}</strong>${badge}<br>total: ${d.total}<br>${rows}`;
        tip.style.display = 'block';
        tip.style.left = (e.pageX + 14) + 'px';
        tip.style.top  = (e.pageY - 10) + 'px';
      })
      .on('mousemove', e => {
        const tip = document.getElementById('tooltip');
        tip.style.left = (e.pageX + 14) + 'px';
        tip.style.top  = (e.pageY - 10) + 'px';
      })
      .on('mouseout', e => {
        select(e.currentTarget).attr('stroke-opacity', 0.6).attr('stroke-width', 1);
        document.getElementById('tooltip').style.display = 'none';
      });
  }

  // agents: circle with gradient + glow
  node.filter(d => !d.team).append('circle')
    .attr('r', d => rScale(d.total))
    .attr('fill', d => `url(#g-${d.id.replace(/[@-]/g,'_')})`)
    .attr('stroke', d => roleColor(d.id))
    .attr('stroke-width', 1).attr('stroke-opacity', 0.6)
    .attr('filter', 'url(#glow)')
    .call(addInteraction);

  // teams: diamond shape
  node.filter(d => d.team).append('polygon')
    .attr('points', d => diamond(rScale(d.total) * 1.1))
    .attr('fill', d => `url(#g-${d.id.replace(/[@-]/g,'_')})`)
    .attr('stroke', d => roleColor(d.id))
    .attr('stroke-width', 1.5).attr('stroke-opacity', 0.8)
    .attr('stroke-dasharray', '4 2')
    .attr('filter', 'url(#glow)')
    .call(addInteraction);

  // label
  node.append('text')
    .attr('dy', d => rScale(d.total) * (d.team ? 1.2 : 1) + 14)
    .attr('text-anchor', 'middle')
    .attr('font-size', '10px')
    .attr('fill', () => getComputedStyle(document.documentElement).getPropertyValue('--node-text').trim() || '#333')
    .attr('pointer-events', 'none')
    .text(d => d.team ? `${d.id} ◆` : d.id);

  // curved path helper
  function arcPath(d) {
    const sx = d.source.x, sy = d.source.y;
    const tx = d.target.x, ty = d.target.y;
    const dx = tx - sx, dy = ty - sy;
    const dr = Math.sqrt(dx*dx + dy*dy) * 1.4;
    return `M${sx},${sy}A${dr},${dr} 0 0,1 ${tx},${ty}`;
  }

  currentSim.on('tick', () => {
    link.attr('d', arcPath);
    node.attr('transform', d => `translate(${d.x},${d.y})`);
  });
}

// drift speed slider — Alpine x-data が driftVal テキスト表示を担当。
// speedSlider.value は setInterval 内で直接 DOM から読むため参照を保持。
const speedSlider = document.getElementById('drift-speed');

let drifting = true;
setInterval(() => {
  if (!drifting || !currentSim) return;
  const s = parseFloat(speedSlider.value);
  if (s === 0) return;
  currentSim.nodes().forEach(d => {
    if (d.fx != null) return;
    d.vx = (d.vx || 0) + (Math.random() - 0.5) * s * 0.2;
    d.vy = (d.vy || 0) + (Math.random() - 0.5) * s * 0.2;
  });
  currentSim.alpha(Math.max(currentSim.alpha(), s * 0.015)).restart();
}, 1000);

svg.on('mousedown', () => { drifting = false; })
   .on('mouseup',   () => { setTimeout(() => { drifting = true; }, 800); });

// top-n slider — Alpine x-data が topN テキスト表示と $dispatch('topn-change') を担当。
// 初期描画のみここで行い、以降の更新は topn-change カスタムイベント経由で受け取る。
const topNSlider = document.getElementById('top-n');

// Alpine の $dispatch は bubbles:true CustomEvent を発火するため window で受信可能。
window.addEventListener('topn-change', e => { redraw(e.detail.n); });

// 初期描画 (slider の default value を使用)
redraw(parseInt(topNSlider.value, 10));

} // end if (pane)

// resizable divider (= mesh+matrix combined view 専用、 mesh-only / matrix-only / alt
// view では #divider と #heatmap-pane が存在しないので early return で no-op 化)。
// 2026-05-20 Mesh/Matrix 分離 (= operator follow-up dispatch、 PR #111 後継): 共通 HTML
// template + mesh JS bottom block を全 view 共通で配信するため、 element 不在時の
// null-guard が必要。
(function() {
  const div = document.getElementById('divider');
  const hm  = document.getElementById('heatmap-pane');
  if (!div || !hm) return;  // mesh+matrix combined view 以外では divider drag 無効
  let dragging = false, startX = 0, startW = 0;
  div.addEventListener('mousedown', e => {
    dragging = true; startX = e.clientX; startW = hm.offsetWidth;
    div.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const delta = startX - e.clientX;
    const newW = Math.max(200, Math.min(window.innerWidth - 300, startW + delta));
    hm.style.width = newW + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    div.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();

// theme toggle — Alpine x-data が body.dark クラスとボタンテキストを担当。
// D3 ノードテキスト色の更新のみここで行う (module スコープの selectAll が必要なため)。
// Alpine の $dispatch('theme-changed') → window CustomEvent (bubbles:true) で受信。
window.addEventListener('theme-changed', () => {
  const nc = getComputedStyle(document.documentElement).getPropertyValue('--node-text').trim();
  selectAll('.node text').attr('fill', nc);
});

// heatmap tooltip
document.querySelectorAll('td[data-n]').forEach(td => {
  td.title = td.dataset.from + ' → ' + td.dataset.to + ': ' + td.dataset.n + ' msgs';
});
</script>
</body>
</html>"""


def build_heatmap(top, counts, totals):
    """sender × recipient ヒートマップ HTML を build (= View 2)。

    cell 色は msg count 比率で gradient、 self cell (= s==r) は dim。
    handle name は `esc()` / `esc_attr()` で XSS-safe 化 (= issue #99 統合)。
    """
    max_val = max(
        (counts.get((s, r), 0) for s in top for r in top if s != r), default=1
    )

    def cell_bg(n):
        if n == 0:
            return "#0d1117"
        t = n / max_val
        r = int(13 + t * 108)
        g = int(17 + t * 175)
        b = int(23 + t * 232)
        return f"rgb({r},{g},{b})"

    def cell_fg(n):
        return "#0d1117" if n / max_val > 0.45 else "#e6edf3"

    lines = ["<table class='hm'>"]
    lines.append("<tr><th class='rl'>from \\ to</th>")
    for r in top:
        # handle name の先頭 `@` を除いた 8 文字を column header 化、 escape を介して挿入
        lines.append(f"<th>{esc(r[1:][:8])}</th>")
    lines.append("<th class='tc'>tot</th></tr>")

    for s in top:
        lines.append("<tr>")
        lines.append(f"<th class='rl'>{esc(s)}</th>")
        for r in top:
            if s == r:
                lines.append("<td class='self'>—</td>")
            else:
                n = counts.get((s, r), 0)
                bg = cell_bg(n)
                fg = cell_fg(n) if n else "#21262d"
                label = str(n) if n else ""
                lines.append(
                    f"<td style='background:{bg};color:{fg}' "
                    f"data-n='{n}' data-from='{esc_attr(s)}' data-to='{esc_attr(r)}'>"
                    f"{esc(label)}</td>"
                )
        lines.append(f"<td class='tc'>{totals[s]}</td>")
        lines.append("</tr>")
    lines.append("</table>")
    return "\n".join(lines)


# ============================================================
# View 3: Agent Detail (= issue #103)
# ============================================================

def get_agent_detail_data(handle):
    """単一 agent の詳細データを取得 (= View 3)。

    Args:
        handle: `@<name>` format の handle (= raw user input、 SQL injection は
                ? placeholder で防ぐが、 handle 自体は app 層の `^[\\w-]+$` regex で
                validated 前提)。 startswith `@` の guard も入れる (= 明白な malformed
                を early reject)。

    Returns:
        dict: {handle, found, in_count, out_count, total, last_active, mode, top_peers,
               tenants_active_in}
        found=False の場合は他 field は None / 0 (= 不在 handle の handler 用)
    """
    if not isinstance(handle, str) or not handle.startswith("@"):
        return {"handle": handle, "found": False, "in_count": 0, "out_count": 0,
                "total": 0, "last_active": None, "mode": None, "top_peers": [],
                "tenants_active_in": []}

    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()

    # tenant filter clause + params
    if TENANT is None:
        tf_clause = ""
        tf_params = ()
    else:
        tf_clause = " AND tenant_id = ?"
        tf_params = (TENANT,)

    # in/out counts
    cur.execute(
        f"SELECT COUNT(*) FROM messages WHERE recipient = ?{tf_clause}",
        (handle, *tf_params),
    )
    in_count = cur.fetchone()[0]
    cur.execute(
        f"SELECT COUNT(*) FROM messages WHERE sender = ?{tf_clause}",
        (handle, *tf_params),
    )
    out_count = cur.fetchone()[0]
    total = in_count + out_count

    # last active = MAX of message timestamps (= sender or recipient)
    cur.execute(
        f"SELECT MAX(created_at) FROM messages WHERE (sender = ? OR recipient = ?){tf_clause}",
        (handle, handle, *tf_params),
    )
    last_active = cur.fetchone()[0]

    # mode + found (= participants table)
    if TENANT is None:
        cur.execute(
            "SELECT mode, MAX(created_at) FROM participants WHERE name = ? GROUP BY name",
            (handle,),
        )
    else:
        cur.execute(
            "SELECT mode FROM participants WHERE name = ? AND tenant_id = ?",
            (handle, TENANT),
        )
    mode_row = cur.fetchone()
    found = mode_row is not None or total > 0
    mode = mode_row[0] if mode_row else None

    # tenants active in (= multi-tenant aggregate 時のみ意味あり)
    tenants_active_in = []
    if TENANT is None:
        cur.execute(
            "SELECT DISTINCT tenant_id FROM messages WHERE sender = ? OR recipient = ?",
            (handle, handle),
        )
        tenants_active_in = [row[0] for row in cur.fetchall()]
    else:
        tenants_active_in = [TENANT] if total > 0 else []

    # top peers (= 双方向の合算 ranking)
    cur.execute(
        f"""
        SELECT peer, SUM(c) AS total FROM (
            SELECT recipient AS peer, COUNT(*) AS c FROM messages
            WHERE sender = ?{tf_clause}
            GROUP BY recipient
            UNION ALL
            SELECT sender AS peer, COUNT(*) AS c FROM messages
            WHERE recipient = ?{tf_clause}
            GROUP BY sender
        )
        GROUP BY peer
        ORDER BY total DESC
        LIMIT 20
        """,
        (handle, *tf_params, handle, *tf_params),
    )
    top_peers = [{"peer": row[0], "count": row[1]} for row in cur.fetchall()]
    con.close()

    return {
        "handle": handle,
        "found": found,
        "in_count": in_count,
        "out_count": out_count,
        "total": total,
        "last_active": last_active,
        "mode": mode,
        "top_peers": top_peers,
        "tenants_active_in": tenants_active_in,
    }


def render_agent_detail(handle):
    """Agent Detail page (= View 3) の body HTML を build。"""
    d = get_agent_detail_data(handle)
    h_safe = esc(d["handle"])

    if not d["found"] and d["total"] == 0:
        return (
            f"<div class='view-content'><h2>Agent Detail</h2>"
            f"<div class='detail-card'><p class='not-found'>"
            f"agent <strong>{h_safe}</strong> not found in {esc(TENANT or 'any tenant')}."
            f"</p></div></div>"
        )

    mode_label = esc(d["mode"]) if d["mode"] else "(unknown)"
    last_active = esc(d["last_active"]) if d["last_active"] else "(no messages)"
    tenants_label = esc(", ".join(d["tenants_active_in"])) if d["tenants_active_in"] else "(none)"

    # top peers list
    peer_rows = []
    for p in d["top_peers"]:
        p_safe = esc(p["peer"])
        peer_rows.append(
            f"<li><a href='/?agent={esc_attr(p['peer'])}'>{p_safe}</a> "
            f"<span class='dim'>{p['count']} msgs</span></li>"
        )
    peer_html = "<ol class='peer-list'>" + "".join(peer_rows) + "</ol>" if peer_rows else "<p class='dim'>(no peers)</p>"

    return f"""<div class='view-content'>
<h2>Agent Detail: {h_safe}</h2>
<div class='detail-card'>
  <div class='detail-stats'>
    <div class='stat-box'><span class='stat-num'>{d['total']}</span><span class='stat-label'>total messages</span></div>
    <div class='stat-box'><span class='stat-num'>{d['in_count']}</span><span class='stat-label'>received (in)</span></div>
    <div class='stat-box'><span class='stat-num'>{d['out_count']}</span><span class='stat-label'>sent (out)</span></div>
    <div class='stat-box'><span class='stat-num'>{len(d['top_peers'])}</span><span class='stat-label'>distinct peers</span></div>
  </div>
  <table class='detail-meta'>
    <tr><th>type (mode)</th><td>{mode_label}</td></tr>
    <tr><th>last active</th><td>{last_active}</td></tr>
    <tr><th>tenants active in</th><td>{tenants_label}</td></tr>
  </table>
  <h3>Top peers (= bidirectional message count)</h3>
  {peer_html}
</div>
</div>"""


# ============================================================
# View 4: Timeline (= issue #103)
# ============================================================

def get_timeline_data(range_label="7d"):
    """Time-bucket message volume data (= View 4)。

    Args:
        range_label: "24h" / "7d" / "30d" のいずれか

    Returns:
        dict: {range_label, buckets: [{time: ISO 形式, count: int}, ...], total}
    """
    # bucket granularity + lookback の table
    if range_label == "24h":
        bucket_format = "%Y-%m-%d %H:00"  # hourly
        lookback_sql = "datetime('now', '-24 hours')"
        limit = 24
    elif range_label == "30d":
        bucket_format = "%Y-%m-%d"  # daily
        lookback_sql = "datetime('now', '-30 days')"
        limit = 30
    else:  # default 7d
        range_label = "7d"
        bucket_format = "%Y-%m-%d %H:00"  # hourly
        lookback_sql = "datetime('now', '-7 days')"
        limit = 168

    if TENANT is None:
        sql = f"""
            SELECT strftime('{bucket_format}', created_at) AS bucket, COUNT(*) AS c
            FROM messages
            WHERE datetime(created_at) >= {lookback_sql}
            GROUP BY bucket
            ORDER BY bucket ASC
            LIMIT ?
        """
        params = (limit,)
    else:
        sql = f"""
            SELECT strftime('{bucket_format}', created_at) AS bucket, COUNT(*) AS c
            FROM messages
            WHERE tenant_id = ? AND datetime(created_at) >= {lookback_sql}
            GROUP BY bucket
            ORDER BY bucket ASC
            LIMIT ?
        """
        params = (TENANT, limit)

    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()
    cur.execute(sql, params)
    buckets = [{"time": row[0], "count": row[1]} for row in cur.fetchall()]
    con.close()
    total = sum(b["count"] for b in buckets)
    return {"range_label": range_label, "buckets": buckets, "total": total}


def get_agent_activity_data(range_label="7d"):
    """Time-bucket agent activity data (= issue #113)。

    is_online は sessions Map (runtime) で保持されており SQLite には永続化されていないため、
    messages テーブルの COUNT(DISTINCT sender) を "active" の proxy として使用する。
    - active:    そのバケット内にメッセージを送信した distinct agent 数
    - registered: participants の non-deleted 総数 (= 現在値; 歴史的変化は非追跡)
    - idle:      registered - active の近似値 (最低 0)

    Args:
        range_label: "24h" / "7d" / "30d" のいずれか

    Returns:
        dict: {range_label, buckets: [{time, active, idle}], registered}
    """
    if range_label == "24h":
        bucket_format = "%Y-%m-%d %H:00"
        lookback_sql = "datetime('now', '-24 hours')"
        limit = 24
    elif range_label == "30d":
        bucket_format = "%Y-%m-%d"
        lookback_sql = "datetime('now', '-30 days')"
        limit = 30
    else:
        range_label = "7d"
        bucket_format = "%Y-%m-%d %H:00"
        lookback_sql = "datetime('now', '-7 days')"
        limit = 168

    if TENANT is None:
        active_sql = f"""
            SELECT strftime('{bucket_format}', created_at) AS bucket,
                   COUNT(DISTINCT sender) AS c
            FROM messages
            WHERE datetime(created_at) >= {lookback_sql}
            GROUP BY bucket
            ORDER BY bucket ASC
            LIMIT ?
        """
        active_params = (limit,)
        reg_sql = "SELECT COUNT(*) FROM participants WHERE deleted_at IS NULL"
        reg_params = ()
    else:
        active_sql = f"""
            SELECT strftime('{bucket_format}', created_at) AS bucket,
                   COUNT(DISTINCT sender) AS c
            FROM messages
            WHERE tenant_id = ? AND datetime(created_at) >= {lookback_sql}
            GROUP BY bucket
            ORDER BY bucket ASC
            LIMIT ?
        """
        active_params = (TENANT, limit)
        reg_sql = "SELECT COUNT(*) FROM participants WHERE tenant_id = ? AND deleted_at IS NULL"
        reg_params = (TENANT,)

    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()
    cur.execute(active_sql, active_params)
    buckets = [{"time": row[0], "active": row[1]} for row in cur.fetchall()]
    cur.execute(reg_sql, reg_params)
    registered = cur.fetchone()[0]
    con.close()

    for b in buckets:
        b["idle"] = max(0, registered - b["active"])

    return {"range_label": range_label, "buckets": buckets, "registered": registered}


def render_timeline(range_label="7d"):
    """Timeline page (= View 4) の body HTML を build。 D3.js で line chart 描画。"""
    d = get_timeline_data(range_label)
    a = get_agent_activity_data(range_label)
    # active class for range selector
    range_buttons = []
    for r in ["24h", "7d", "30d"]:
        cls = "range-btn active" if r == d["range_label"] else "range-btn"
        range_buttons.append(
            f"<a href='/?view=timeline&range={r}' class='{cls}'>{r}</a>"
        )
    range_nav = " ".join(range_buttons)
    buckets_json = json.dumps(d["buckets"])
    agent_buckets_json = json.dumps(a["buckets"])
    registered = a["registered"]

    return f"""<div class='view-content'>
<h2>Timeline — message volume over time</h2>
<div class='timeline-controls'>
  <span class='dim'>range:</span> {range_nav}
  <span class='dim' style='margin-left:20px'>total: <strong>{d['total']}</strong> messages in last {d['range_label']}</span>
</div>
<div id='timeline-chart' style='width:100%; height:400px; margin-top:16px'></div>
<script type="module">
import {{ select }} from 'https://cdn.jsdelivr.net/npm/d3-selection@3/+esm';
import {{ scaleBand, scaleLinear }} from 'https://cdn.jsdelivr.net/npm/d3-scale@4/+esm';
import {{ max }} from 'https://cdn.jsdelivr.net/npm/d3-array@3/+esm';
import {{ axisLeft, axisBottom }} from 'https://cdn.jsdelivr.net/npm/d3-axis@3/+esm';
const tlBuckets = {buckets_json};
const tlContainer = document.getElementById('timeline-chart');
const tlW = tlContainer.offsetWidth, tlH = tlContainer.offsetHeight;
const tlMargin = {{top: 20, right: 30, bottom: 60, left: 50}};
const tlIW = tlW - tlMargin.left - tlMargin.right;
const tlIH = tlH - tlMargin.top - tlMargin.bottom;

const tlSvg = select('#timeline-chart').append('svg')
  .attr('width', tlW).attr('height', tlH)
  .append('g').attr('transform', `translate(${{tlMargin.left}},${{tlMargin.top}})`);

if (tlBuckets.length === 0) {{
  tlSvg.append('text').attr('x', tlIW/2).attr('y', tlIH/2).attr('text-anchor', 'middle')
    .attr('fill', getComputedStyle(document.documentElement).getPropertyValue('--text2').trim())
    .text('No messages in selected range');
}} else {{
  const tlX = scaleBand().domain(tlBuckets.map(d => d.time)).range([0, tlIW]).padding(0.1);
  const tlY = scaleLinear().domain([0, max(tlBuckets, d => d.count) || 1]).range([tlIH, 0]).nice();

  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  tlSvg.selectAll('.bar').data(tlBuckets).join('rect')
    .attr('x', d => tlX(d.time)).attr('y', d => tlY(d.count))
    .attr('width', tlX.bandwidth()).attr('height', d => tlIH - tlY(d.count))
    .attr('fill', accent).attr('opacity', 0.8);

  // tooltip on hover
  tlSvg.selectAll('rect')
    .append('title')
    .text(d => `${{d.time}}: ${{d.count}} msgs`);

  // Y axis
  tlSvg.append('g').call(axisLeft(tlY).ticks(5));

  // X axis with rotated labels (subset)
  const tickEvery = Math.max(1, Math.floor(tlBuckets.length / 12));
  const tlXAxis = axisBottom(tlX).tickValues(tlBuckets.filter((_, i) => i % tickEvery === 0).map(d => d.time));
  tlSvg.append('g').attr('transform', `translate(0,${{tlIH}})`).call(tlXAxis)
    .selectAll('text').attr('transform', 'rotate(-45)').attr('text-anchor', 'end').attr('dx', '-0.5em').attr('dy', '0.5em')
    .attr('font-size', '10px');
}}
</script>

<h2 style='margin-top:40px'>Timeline — agent activity over time</h2>
<div style='margin-bottom:8px'>
  <span class='dim'>registered agents (current): <strong>{registered}</strong></span>
  &nbsp;
  <span style='display:inline-flex;align-items:center;gap:4px;margin-left:16px'>
    <span style='display:inline-block;width:12px;height:12px;background:var(--accent);opacity:0.9;border-radius:2px'></span>
    <span class='dim'>active (sent msg in bucket)</span>
  </span>
  <span style='display:inline-flex;align-items:center;gap:4px;margin-left:12px'>
    <span style='display:inline-block;width:12px;height:12px;background:#888;opacity:0.45;border-radius:2px'></span>
    <span class='dim'>idle (registered − active)</span>
  </span>
</div>
<p class='dim' style='font-size:11px;margin:0 0 8px'>
  ※ is_online は runtime 非永続のため、"active" = そのバケット内に送信した distinct agent 数で近似
</p>
<div id='agent-activity-chart' style='width:100%; height:320px; margin-top:8px'></div>
<script type="module">
import {{ select }} from 'https://cdn.jsdelivr.net/npm/d3-selection@3/+esm';
import {{ scaleBand, scaleLinear }} from 'https://cdn.jsdelivr.net/npm/d3-scale@4/+esm';
import {{ max }} from 'https://cdn.jsdelivr.net/npm/d3-array@3/+esm';
import {{ axisLeft, axisBottom }} from 'https://cdn.jsdelivr.net/npm/d3-axis@3/+esm';
import {{ format }} from 'https://cdn.jsdelivr.net/npm/d3-format@3/+esm';
const agBuckets = {agent_buckets_json};
const agRegistered = {registered};
const agContainer = document.getElementById('agent-activity-chart');
const agW = agContainer.offsetWidth, agH = agContainer.offsetHeight;
const agMargin = {{top: 20, right: 30, bottom: 60, left: 50}};
const agIW = agW - agMargin.left - agMargin.right;
const agIH = agH - agMargin.top - agMargin.bottom;

const agSvg = select('#agent-activity-chart').append('svg')
  .attr('width', agW).attr('height', agH)
  .append('g').attr('transform', `translate(${{agMargin.left}},${{agMargin.top}})`);

if (agBuckets.length === 0) {{
  agSvg.append('text').attr('x', agIW/2).attr('y', agIH/2).attr('text-anchor', 'middle')
    .attr('fill', getComputedStyle(document.documentElement).getPropertyValue('--text2').trim())
    .text('No agent activity in selected range');
}} else {{
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  const agX = scaleBand().domain(agBuckets.map(d => d.time)).range([0, agIW]).padding(0.1);
  const yMax = Math.max(agRegistered, max(agBuckets, d => d.active + d.idle) || 1);
  const agY = scaleLinear().domain([0, yMax]).range([agIH, 0]).nice();

  // stacked bars: active (bottom, accent) + idle (top, grey)
  // active bars start from the axis baseline
  agSvg.selectAll('.bar-active').data(agBuckets).join('rect')
    .attr('class', 'bar-active')
    .attr('x', d => agX(d.time))
    .attr('y', d => agY(d.active))
    .attr('width', agX.bandwidth())
    .attr('height', d => agIH - agY(d.active))
    .attr('fill', accent).attr('opacity', 0.85);

  // idle bars stacked on top of active (from active to active+idle = registered)
  agSvg.selectAll('.bar-idle').data(agBuckets).join('rect')
    .attr('class', 'bar-idle')
    .attr('x', d => agX(d.time))
    .attr('y', d => agY(d.idle + d.active))
    .attr('width', agX.bandwidth())
    .attr('height', d => agY(d.active) - agY(d.idle + d.active))
    .attr('fill', '#888').attr('opacity', 0.35);

  // tooltips
  agSvg.selectAll('.bar-active').append('title')
    .text(d => `${{d.time}}\nactive: ${{d.active}}\nidle: ${{d.idle}}`);
  agSvg.selectAll('.bar-idle').append('title')
    .text(d => `${{d.time}}\nactive: ${{d.active}}\nidle: ${{d.idle}}`);

  // dashed reference line at registered count
  if (agRegistered > 0) {{
    agSvg.append('line')
      .attr('x1', 0).attr('x2', agIW)
      .attr('y1', agY(agRegistered)).attr('y2', agY(agRegistered))
      .attr('stroke', '#aaa').attr('stroke-dasharray', '4,3').attr('stroke-width', 1);
    agSvg.append('text')
      .attr('x', agIW + 4).attr('y', agY(agRegistered) + 4)
      .attr('font-size', '10px')
      .attr('fill', getComputedStyle(document.documentElement).getPropertyValue('--text2').trim())
      .text(`registered (${{agRegistered}})`);
  }}

  // Y axis (integer ticks)
  agSvg.append('g').call(axisLeft(agY).ticks(Math.min(yMax, 6)).tickFormat(format('d')));

  // X axis
  const agTickEvery = Math.max(1, Math.floor(agBuckets.length / 12));
  const agXAxis = axisBottom(agX)
    .tickValues(agBuckets.filter((_, i) => i % agTickEvery === 0).map(d => d.time));
  agSvg.append('g').attr('transform', `translate(0,${{agIH}})`).call(agXAxis)
    .selectAll('text').attr('transform', 'rotate(-45)').attr('text-anchor', 'end')
    .attr('dx', '-0.5em').attr('dy', '0.5em').attr('font-size', '10px');
}}
</script>
</div>"""


# ============================================================
# View 5: Link List (= issue #103)
# ============================================================

def get_link_list_data(limit=50):
    """Top links (= sender↔recipient pairs) by message count (= View 5)。

    bidirectional aggregation: `(min(s,r), max(s,r))` で正規化して合算。
    issue #103 body の 「@planner <-> @reviewer: 359」 表現と一致。

    Returns:
        list of dicts: [{a, b, total, a_to_b, b_to_a}, ...] 降順
    """
    if TENANT is None:
        sql = "SELECT sender, recipient, COUNT(*) FROM messages GROUP BY sender, recipient"
        params = ()
    else:
        sql = "SELECT sender, recipient, COUNT(*) FROM messages WHERE tenant_id = ? GROUP BY sender, recipient"
        params = (TENANT,)

    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()
    cur.execute(sql, params)
    raw = cur.fetchall()
    con.close()

    # bidirectional aggregate: key = (min, max) tuple
    agg = {}  # (a, b) → {total, a_to_b, b_to_a}
    for s, r, c in raw:
        if s == r:
            # self-message: 通常稀、 same-side 表示で取り扱い
            key = (s, r)
            agg.setdefault(key, {"total": 0, "a_to_b": 0, "b_to_a": 0})
            agg[key]["total"] += c
            agg[key]["a_to_b"] += c
            continue
        a, b = (s, r) if s < r else (r, s)
        key = (a, b)
        agg.setdefault(key, {"total": 0, "a_to_b": 0, "b_to_a": 0})
        agg[key]["total"] += c
        if s == a:
            agg[key]["a_to_b"] += c
        else:
            agg[key]["b_to_a"] += c

    items = [
        {"a": k[0], "b": k[1], "total": v["total"],
         "a_to_b": v["a_to_b"], "b_to_a": v["b_to_a"]}
        for k, v in agg.items()
    ]
    items.sort(key=lambda x: -x["total"])
    return items[:limit]


def render_link_list():
    """Link List page (= View 5) の body HTML を build。"""
    items = get_link_list_data(limit=50)
    if not items:
        return (
            "<div class='view-content'><h2>Link List</h2>"
            "<p class='dim'>(no links yet)</p></div>"
        )

    max_total = max(i["total"] for i in items) if items else 1
    rows = []
    for i, link in enumerate(items, 1):
        a_safe = esc(link["a"])
        b_safe = esc(link["b"])
        bar_pct = int((link["total"] / max_total) * 100)
        rows.append(f"""
<tr>
  <td class='rank'>{i}</td>
  <td><a href='/?agent={esc_attr(link['a'])}'>{a_safe}</a>
      &nbsp;↔&nbsp;
      <a href='/?agent={esc_attr(link['b'])}'>{b_safe}</a></td>
  <td class='cell-num'>{link['total']}</td>
  <td class='cell-num dim'>{link['a_to_b']}→</td>
  <td class='cell-num dim'>←{link['b_to_a']}</td>
  <td class='bar-cell'><div class='bar' style='width:{bar_pct}%'></div></td>
</tr>""")
    body = "".join(rows)

    return f"""<div class='view-content'>
<h2>Link List — top {len(items)} strongest links</h2>
<p class='dim'>bidirectional message exchange (a↔b)、 ↔ で合算、 a→b / b→a で direction 内訳。 click handle で Agent Detail へ。</p>
<table class='link-list'>
  <thead><tr><th>#</th><th>link</th><th>total</th><th>a→b</th><th>b→a</th><th>volume</th></tr></thead>
  <tbody>{body}</tbody>
</table>
</div>"""


def render_nav_bar(current_view, agent_handle=None):
    """nav bar HTML (= 全 view 切替 + section grouping)。

    2026-05-20 UX fix (= operator feedback 「mesh + matrix と agent detail の違いが
    分かりにくい」): nav を **2 section に grouping** して全体ビュー / 個別ドリルダウン
    の区別を視覚化。

    2026-05-20 Mesh/Matrix 分離 (= operator follow-up dispatch、 旧 PR #111 直後):
    旧 「Mesh + Matrix」 合体 link を 「Mesh」 + 「Matrix」 の **2 独立 link** に分離。
    overview group は 4 link (= Mesh + Matrix + Timeline + Link List) に拡張。

    - **Overview** (= mesh + matrix + timeline + link list): 全体構造を 4 つの異なる
      角度 (graph / heatmap / time / pair list) で観察する全体ビュー群
    - **Drill-down** (= agent detail): 1 つの handle に絞った個別ビュー、 mesh /
      link list 上の click から入る drill-down 動線

    section 間に vertical divider + label で grouping を明示、 agent detail は handle
    未指定なら disabled state (= 「Mesh / Link List から handle を click」 hint 付き)
    で 「直接 navigate できない drill-down view」 であることを表現。

    Suggestion 3 (= PR #111 reviewer): `nav-divider` に `role="separator"` +
    `aria-orientation="vertical"` を付与 (= screen reader 等 a11y tool に 「ここで
    視覚的 section break が起きている」 を伝える ARIA semantic)。
    """
    # Overview group (= 全体構造を見る view 群、 6 link)
    overview_items = [
        ("mesh",       "Mesh",          "/"),
        ("matrix",     "Matrix",        "/?view=matrix"),
        ("timeline",   "Timeline",      "/?view=timeline"),
        ("links",      "Link List",     "/?view=links"),
        ("health",     "🔥 Health",     "/?view=health"),
        ("causaltree", "📎 Causal Tree","/?view=causaltree"),
    ]
    # Drill-down group (= 個別 handle 観察 view)
    # XSS fix (= PR #104 review Critical 1、 2026-05-20): agent_handle は URL query
    # 由来で DB validation を経由しないため `^[\w-]+$` regex の保証が効かない。
    # `esc_attr()` で attribute-breakout (= `" onclick="...`) を防ぐ。
    drilldown_url = "/?view=agent" + (
        f"&agent={esc_attr(agent_handle)}" if agent_handle else ""
    )

    overview_links = []
    for key, label, url in overview_items:
        cls = "active" if current_view == key else ""
        overview_links.append(f'<a class="{cls}" href="{url}">{label}</a>')

    # Agent Detail link: handle 未指定 = disabled state + 動線 hint
    if current_view == "agent" and agent_handle:
        drill_link = f'<a class="active" href="{drilldown_url}">Agent Detail</a>'
    elif agent_handle:
        # handle が context として与えられている (= 他 view 経由で carry) → 有効リンク
        drill_link = f'<a href="{drilldown_url}">Agent Detail</a>'
    else:
        # handle 未指定: 直接 navigate 不可、 click 動線案内
        drill_link = (
            '<a class="disabled" href="/" '
            'title="Agent Detail を開くには、 Mesh View / Link List で handle を click してください '
            '(= 個別 drill-down view、 単独 navigation 不可)">'
            'Agent Detail</a>'
        )

    return (
        "<div id='nav-bar'>"
        "<span class='nav-section-label'>overview</span>"
        + "".join(overview_links)
        + "<span class='nav-divider' role='separator' aria-orientation='vertical'></span>"
        + "<span class='nav-section-label'>drill-down</span>"
        + drill_link
        + "</div>"
    )


# HTML template から旧 「Mesh + Matrix 合体 main div」 (= graph-pane + divider +
# heatmap-pane) を identify するための定数 (= replace target、 全 render 関数で共有)。
# 旧 PR #111 までは default route で配信されていた layout、 2026-05-20 mesh/matrix
# 分離以降は **どの view でも使われない** (= 各 render 関数が view 固有 layout に置換)。
_MAIN_DIV_TEMPLATE = (
    '<div id="main">\n'
    '  <div id="graph-pane">\n'
    '    <svg id="svg"></svg>\n'
    '    <div id="graph-hint">drag: move node &nbsp; scroll: zoom</div>\n'
    '  </div>\n'
    '  <div id="divider"></div>\n'
    '  <div id="heatmap-pane">\n'
    '    <h2>message matrix</h2>\n'
    '    HEATMAP_HTML\n'
    '  </div>\n'
    '</div>'
)


def render_alt_view_layout(view_name, body_html, total_msgs, total_agents, total_links, agent_handle=None):
    """alt views (= Agent Detail / Timeline / Link List / Matrix) 用の minimal layout。

    HTML template の `<div id="main">...</div>` block を
    `<div class="alt-main">{body_html}</div>` に置換した form を返す。

    HTML 全体 layout (= 共通 header + nav + theme system + d3 import) は維持。

    2026-05-20 Mesh/Matrix 分離 (= operator follow-up): matrix-only も本 helper を
    使う pattern として add (= body_html に heatmap table を埋める)。
    """
    nav_bar = render_nav_bar(view_name, agent_handle=agent_handle)
    # alt-main wrapper を用意、 mesh-specific layout を simpler view 用に差し替え
    alt_main = f'<div class="alt-main">{body_html}</div>'
    body = (
        HTML.replace("BODY_CLASS", f"view-{view_name}")
        .replace("NAV_BAR_HTML", nav_bar)
        # mesh-specific main div 全体を alt-main に置換
        .replace(_MAIN_DIV_TEMPLATE, alt_main)
        # mesh-specific JS は実行されると undefined 参照 (= NODES_JSON 等) で error なので、
        # dummy data を空 array で feed して silent化 (= divider drag は null-guard で no-op)
        .replace("NODES_JSON", "[]")
        .replace("LINKS_JSON", "[]")
        .replace("TOTAL_MSGS", str(total_msgs))
        .replace("TOTAL_AGENTS", str(total_agents))
        .replace("TOTAL_LINKS", str(total_links))
        .replace("TENANT_LABEL", esc(TENANT) if TENANT is not None else "all tenants")
        .replace("NODE_COUNT", "0")
        .replace("NODE_DEFAULT", "0")
    )
    return body.encode("utf-8")


def render_mesh_only(nodes, links, total_msgs, total_agents, total_links):
    """Mesh-only view (= D3 force-directed graph 単独、 heatmap pane なし)。

    2026-05-20 Mesh/Matrix 分離 (= operator follow-up): 旧 `render_mesh_view`
    (= mesh + matrix 合体) を分割した片割れ。 graph-pane を main div の全幅に占有させ、
    heatmap pane + divider は削除。 既存 D3 force-graph JS (= body 末尾 inline script)
    は real NODES/LINKS data を受けて normal に動作。

    drift slider (= header 内) は本 view でのみ effective、 他 view では CSS で hide
    (= `body:not(.view-mesh) #header label`)。
    """
    nav_bar = render_nav_bar("mesh")
    # main div 内容を mesh-only 専用に置換 (= graph-pane full width、 no heatmap)
    mesh_main = (
        '<div id="main" class="mesh-only-layout">\n'
        '  <div id="graph-pane">\n'
        '    <svg id="svg"></svg>\n'
        '    <div id="graph-hint">drag: move node &nbsp; scroll: zoom</div>\n'
        '  </div>\n'
        '</div>'
    )
    node_count = len(nodes)
    node_default = min(node_count, 14)
    body = (
        HTML.replace("BODY_CLASS", "view-mesh")
        .replace("NAV_BAR_HTML", nav_bar)
        .replace(_MAIN_DIV_TEMPLATE, mesh_main)
        .replace("NODES_JSON", json.dumps(nodes))
        .replace("LINKS_JSON", json.dumps(links))
        .replace("TOTAL_MSGS", str(total_msgs))
        .replace("TOTAL_AGENTS", str(total_agents))
        .replace("TOTAL_LINKS", str(total_links))
        .replace("TENANT_LABEL", esc(TENANT) if TENANT is not None else "all tenants")
        .replace("NODE_COUNT", str(node_count))
        .replace("NODE_DEFAULT", str(node_default))
    )
    return body.encode("utf-8")


def render_matrix_only(top, counts, totals, total_msgs, total_agents, total_links):
    """Matrix-only view (= sender × recipient heatmap 単独、 force-graph なし)。

    2026-05-20 Mesh/Matrix 分離 (= operator follow-up): heatmap pane を main div の
    全幅に占有させ、 graph-pane は削除。 既存 mesh JS は empty NODES/LINKS で no-op
    (= `render_alt_view_layout` 経由で silent化)。

    `build_heatmap` の出力をそのまま埋め、 outer に `<h2>` heading + view-content
    wrapper (= 他 alt view と同 styling) を添える。
    """
    heatmap_html = build_heatmap(top, counts, totals)
    body_html = (
        '<div class="view-content">\n'
        '<h2>Matrix — sender × recipient message frequency</h2>\n'
        '<div class="dim" style="font-size:11px;margin-bottom:12px">'
        '上位 14 名の handle 間 message 数 (= 色濃度 = 比率、 hover で正確 count)。'
        '</div>\n'
        + heatmap_html + '\n'
        '</div>'
    )
    return render_alt_view_layout(
        "matrix", body_html, total_msgs, total_agents, total_links,
    )


# ============================================================
# Health view: PPD + EQS data layer (= Phase 1 SHS dashboard)
# ============================================================

def _parse_ts(ts_str):
    """messages.created_at (ISO 8601 with optional trailing Z) を datetime に変換。

    better-sqlite3 が生成するフォーマット: '2026-05-30T07:11:16.437Z'
    Python 3.7〜3.10 の fromisoformat は trailing Z を解釈しないため rstrip する。
    """
    if not ts_str:
        return None
    return datetime.fromisoformat(ts_str.rstrip("Z"))


def compute_ppd_from_db():
    """Ping-Pong Detection (PPD) を messages テーブルから計算。

    Algorithm:
    1. 全メッセージを (sender, recipient) ペア（= 正規化済み min/max）で grouping。
    2. 各ペア内でメッセージを時刻順に並べ、前後の gap > PPD_WINDOW_HOURS で
       セッション分割する。
    3. セッション内の送信者列を圧縮（連続同一 sender → 1 turn）し、
       双方の turn 数の min を「往復数 (rounds)」とする。
    4. rounds >= PPD_WARN_ROUNDS ならピンポン判定（Warning 以上）。

    Returns:
        dict: {threads, total_sessions, ping_pong_count}
          threads: list of {pair, a, b, rounds, msg_count, start, end, severity}
    """
    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()
    if TENANT is None:
        cur.execute(
            "SELECT sender, recipient, created_at FROM messages ORDER BY created_at ASC"
        )
    else:
        cur.execute(
            "SELECT sender, recipient, created_at FROM messages "
            "WHERE tenant_id = ? ORDER BY created_at ASC",
            (TENANT,),
        )
    rows = cur.fetchall()
    con.close()

    # (min, max) ペアでグループ化
    pair_messages = defaultdict(list)
    for sender, recipient, created_at in rows:
        pair = (min(sender, recipient), max(sender, recipient))
        if sender != recipient:  # self-message は除外
            pair_messages[pair].append((sender, recipient, created_at))

    ping_pong_threads = []
    total_sessions = 0

    for pair, msgs in pair_messages.items():
        # セッション分割: gap > PPD_WINDOW_HOURS で新セッション
        sessions = []
        current_session = [msgs[0]]
        for i in range(1, len(msgs)):
            prev_ts = _parse_ts(msgs[i - 1][2])
            curr_ts = _parse_ts(msgs[i][2])
            if prev_ts and curr_ts:
                gap_h = (curr_ts - prev_ts).total_seconds() / 3600
                if gap_h > PPD_WINDOW_HOURS:
                    sessions.append(current_session)
                    current_session = [msgs[i]]
                    continue
            current_session.append(msgs[i])
        sessions.append(current_session)
        total_sessions += len(sessions)

        for session in sessions:
            if len(session) < PPD_WARN_ROUNDS * 2:
                continue  # 往復に必要な最低メッセージ数に満たない

            # 連続同一 sender を 1 turn に圧縮 → sender ごとの turn 数をカウント
            turns: dict[str, int] = {}
            prev_sender = None
            for sender, _, _ in session:
                if sender != prev_sender:
                    turns[sender] = turns.get(sender, 0) + 1
                    prev_sender = sender

            if len(turns) < 2:
                continue  # 一方通行セッション

            rounds = min(turns.values())

            if rounds >= PPD_WARN_ROUNDS:
                sev = (
                    "severe"   if rounds >= PPD_SEVERE_ROUNDS   else
                    "critical" if rounds >= PPD_CRITICAL_ROUNDS else
                    "warning"
                )
                ping_pong_threads.append({
                    "pair":      f"{pair[0]} ↔ {pair[1]}",
                    "a":         pair[0],
                    "b":         pair[1],
                    "rounds":    rounds,
                    "msg_count": len(session),
                    "start":     session[0][2],
                    "end":       session[-1][2],
                    "severity":  sev,
                })

    return {
        "threads":          sorted(ping_pong_threads, key=lambda x: -x["rounds"]),
        "total_sessions":   total_sessions,
        "ping_pong_count":  len(ping_pong_threads),
    }


def compute_eqs_from_db():
    """Escalation Quality Score (EQS) を messages テーブルから計算。

    Algorithm (O(N) 版、 root_message_id によるスレッドグループ化):
    1. messages と message_causes を LEFT JOIN して各メッセージの
       effective_root (= COALESCE(mc.root_message_id, m.id)) を取得。
       root message (= caused_by なし) は m.id が自分自身のスレッドルート。
       JOIN 条件に m.tenant_id = mc.tenant_id を含めてテナント境界を確保。
    2. thread_map = {root_id: [created_at ASC 順のメッセージリスト]} を構築 (O(N))。
       各 msg dict に effective_root を含めるため msg_root dict は不要。
    3. エスカレーション検出 (ESCALATION_SIGNALS マッチ、 宛先不問)。
       旧実装の OPERATOR_HANDLE 宛限定は廃止。全送受信メッセージを対象とする。
    4. 各エスカレーションのスレッドを thread_map から O(1) で取得し、
       エスカレーション後の最初のメッセージ（送信者不問）を返答とする。
    5. 返答本文を GO / 非 GO / unknown に分類。
    6. overescalation_rate = GO数 / 全エスカレーション数 × 100
       quality_score = 100 - |rate - 50| × 2  (50% が理想、 設計書 §3.2.2)

    エスカレーション連鎖の挙動 (既知・意図した仕様):
    [A → B: esc1] → [B → C: esc2] → [C → B: GO] のケースでは
    - esc1 の返答 = esc2（GO/non-go 以外） → unknown にカウント
    - esc2 の返答 = GO → go_count にカウント
    esc1 の返答が unknown になるのは「中継エスカレーション」として許容する。
    将来は "最初の非エスカレーション後続" を返答とするロジックで改善可能。

    旧実装の問題点 (PR #169 Minor):
    - O(N²): 各エスカレーションに対し全メッセージを線形スキャン
    - OPERATOR_HANDLE 宛 / 発信のみ対象 (特定 handle への依存)
    - 24h 窓フィルタが thread 境界と無関係

    Returns:
        dict: {total_escalations, go_count, non_go_count, unknown_count,
               overescalation_rate, quality_score}
    """
    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()

    # LEFT JOIN で effective_root を計算 (1 パス、 O(N log N) for sort)
    # message_causes に存在するメッセージ: effective_root = mc.root_message_id
    # 存在しない (= スレッドルート / standalone):  effective_root = m.id
    # JOIN 条件は TENANT 有無に関わらず m.tenant_id = mc.tenant_id を含める
    # (= 複数テナント混在時に message_id 衝突で誤 JOIN しないよう保護)
    if TENANT is None:
        cur.execute(
            """
            SELECT m.id, m.sender, m.recipient, m.body, m.created_at,
                   COALESCE(mc.root_message_id, m.id) AS effective_root
            FROM messages m
            LEFT JOIN message_causes mc
              ON m.id = mc.message_id AND m.tenant_id = mc.tenant_id
              AND mc.position = 0
            ORDER BY m.created_at ASC
            """
        )
    else:
        cur.execute(
            """
            SELECT m.id, m.sender, m.recipient, m.body, m.created_at,
                   COALESCE(mc.root_message_id, m.id) AS effective_root
            FROM messages m
            LEFT JOIN message_causes mc
              ON m.id = mc.message_id AND m.tenant_id = mc.tenant_id
              AND mc.position = 0
            WHERE m.tenant_id = ?
            ORDER BY m.created_at ASC
            """,
            (TENANT,),
        )
    rows = cur.fetchall()
    con.close()

    # thread_map 構築 (O(N))
    # thread_map[root_id] は created_at ASC 順 (ORDER BY 済み)
    # effective_root は msg dict に含めるため別途 msg_root dict は不要
    thread_map: dict[str, list] = defaultdict(list)
    all_msgs = []

    for msg_id, sender, recipient, body, created_at, effective_root in rows:
        msg = {
            "id": msg_id, "sender": sender, "recipient": recipient,
            "body": body, "created_at": created_at,
            "effective_root": effective_root,
        }
        all_msgs.append(msg)
        thread_map[effective_root].append(msg)

    # エスカレーション検出 (ESCALATION_SIGNALS マッチ、 宛先不問)
    # 宛先不問: 旧実装の OPERATOR_HANDLE 宛限定を廃止し全メッセージ対象に変更
    escalations = [
        m for m in all_msgs
        if any(sig in m["body"] for sig in ESCALATION_SIGNALS)
    ]

    if not escalations:
        return {
            "total_escalations":   0,
            "go_count":            0,
            "non_go_count":        0,
            "unknown_count":       0,
            "overescalation_rate": None,
            "quality_score":       None,
        }

    go_count = non_go_count = unknown_count = 0

    for esc_msg in escalations:
        esc_ts = _parse_ts(esc_msg["created_at"])
        if esc_ts is None:
            unknown_count += 1
            continue

        # スレッドを O(1) で取得し、エスカレーション後の最初のメッセージを返答とする
        # (送信者不問: エスカレーション元・先どちらの返答も対象)
        # エスカレーション連鎖ケース: 返答が別エスカレーションの場合は unknown になる
        # (= 仕様: エスカレーション連鎖挙動コメント参照)
        root_id = esc_msg["effective_root"]
        thread  = thread_map.get(root_id, [])

        response = None
        for msg in thread:                          # created_at ASC 順
            if msg["id"] == esc_msg["id"]:
                continue                           # エスカレーション自身はスキップ
            msg_ts = _parse_ts(msg["created_at"])
            if msg_ts and msg_ts > esc_ts:
                response = msg
                break                             # 最初の後続メッセージを返答とする

        if response is None:
            unknown_count += 1
            continue

        body      = response["body"]
        is_go     = any(sig in body for sig in GO_RESPONSE_SIGNALS)
        is_non_go = any(sig in body for sig in NON_GO_RESPONSE_SIGNALS)

        if is_non_go:
            non_go_count += 1
        elif is_go:
            go_count += 1
        else:
            unknown_count += 1

    total = len(escalations)
    overescalation_rate = round(go_count / total * 100, 1) if total > 0 else 0.0
    quality_score = round(max(0.0, 100 - abs(overescalation_rate - 50) * 2), 1)

    return {
        "total_escalations":   total,
        "go_count":            go_count,
        "non_go_count":        non_go_count,
        "unknown_count":       unknown_count,
        "overescalation_rate": overescalation_rate,
        "quality_score":       quality_score,
    }


def render_health():
    """Health view (= Phase 1 SHS: PPD + EQS) の body HTML を build。"""
    ppd = compute_ppd_from_db()
    eqs = compute_eqs_from_db()

    # ── PPD サマリー ──────────────────────────────────────────────────────────
    total_sessions = max(ppd["total_sessions"], 1)
    ppd_rate = round(ppd["ping_pong_count"] / total_sessions * 100, 1)
    ppd_color = (
        "#39d353" if ppd_rate < 10 else
        "#ffa657" if ppd_rate < 25 else
        "#f78166"
    )

    # PPD アラートテーブル
    threads = ppd["threads"]
    if threads:
        rows_html = []
        for t in threads[:30]:
            sev = t["severity"]
            badge_cls = f"badge badge-{sev}"
            start_s = esc(t["start"][:16].replace("T", " ") if t.get("start") else "—")
            end_s   = esc(t["end"][:16].replace("T", " ")   if t.get("end")   else "—")
            rows_html.append(
                f"<tr>"
                f"<td>{esc(t['a'])}&nbsp;↔&nbsp;{esc(t['b'])}</td>"
                f"<td style='text-align:right'>{t['rounds']}</td>"
                f"<td style='text-align:right'>{t['msg_count']}</td>"
                f"<td><span class='{badge_cls}'>{sev.upper()}</span></td>"
                f"<td style='font-size:10px;color:var(--text2)'>{start_s} → {end_s}</td>"
                f"</tr>"
            )
        ppd_table = (
            "<table class='link-list' style='max-width:100%'>"
            "<thead><tr>"
            "<th>pair</th>"
            "<th style='text-align:right'>rounds</th>"
            "<th style='text-align:right'>msgs</th>"
            "<th>severity</th>"
            "<th>window</th>"
            "</tr></thead>"
            "<tbody>" + "".join(rows_html) + "</tbody>"
            "</table>"
        )
    else:
        ppd_table = (
            f"<p class='dim' style='padding:12px 0'>"
            f"⚑ ピンポンスレッド検出なし (min rounds: {PPD_WARN_ROUNDS})</p>"
        )

    # ── EQS セクション ────────────────────────────────────────────────────────
    if eqs["total_escalations"] == 0:
        eqs_html = (
            "<p class='dim' style='padding:12px 0'>"
            "エスカレーションメッセージが検出されていません。</p>"
        )
    else:
        rate = eqs["overescalation_rate"]
        qs   = eqs["quality_score"]
        rate_color = (
            "#39d353" if 40 <= rate <= 60 else
            "#ffa657" if 25 <= rate <= 75 else
            "#f78166"
        )
        qs_color = (
            "#39d353" if qs >= 70 else
            "#ffa657" if qs >= 40 else
            "#f78166"
        )
        eqs_html = f"""<div class='detail-stats' style='margin-bottom:12px'>
  <div class='stat-box'>
    <span class='stat-num'>{eqs['total_escalations']}</span>
    <span class='stat-label'>total escalations</span>
  </div>
  <div class='stat-box'>
    <span class='stat-num' style='color:{rate_color}'>{rate}%</span>
    <span class='stat-label'>overescalation rate<br><span style='font-size:9px'>(ideal: 40〜60%)</span></span>
  </div>
  <div class='stat-box'>
    <span class='stat-num' style='color:{qs_color}'>{qs}</span>
    <span class='stat-label'>EQS quality score<br><span style='font-size:9px'>(0〜100)</span></span>
  </div>
  <div class='stat-box'>
    <span class='stat-num'>{eqs['go_count']}</span>
    <span class='stat-label'>GO responses</span>
  </div>
  <div class='stat-box'>
    <span class='stat-num'>{eqs['non_go_count']}</span>
    <span class='stat-label'>non-GO responses</span>
  </div>
  <div class='stat-box'>
    <span class='stat-num'>{eqs['unknown_count']}</span>
    <span class='stat-label'>unknown / no reply</span>
  </div>
</div>
<p class='dim health-note'>
  ※ キーワードベース分類。偽陽性あり。EQS_overescalation = GO系返答 / 全エスカレーション × 100。
  理想値 40〜60%（合議過多型燃焼の検出閾値、設計書 §3.2.2）。
</p>"""

    return f"""<div class='view-content'>
<h2>🔥 Structural Health — Phase 1 MVP</h2>
<p class='dim health-note'>
  Phase 1 計測指標: PPD（ピンポン検出）+ EQS（エスカレーション品質）<br>
  燃焼類型対応: 劇場型(2)・合議過多型(6)・無限ループ型(9)
</p>

<div class='detail-stats' style='margin-bottom:24px'>
  <div class='stat-box'>
    <span class='stat-num' style='color:{ppd_color}'>{ppd_rate}%</span>
    <span class='stat-label'>PPD rate<br><span style='font-size:9px'>ping-pong sessions / total</span></span>
  </div>
  <div class='stat-box'>
    <span class='stat-num'>{ppd["ping_pong_count"]}</span>
    <span class='stat-label'>ping-pong threads<br><span style='font-size:9px'>≥{PPD_WARN_ROUNDS} rounds detected</span></span>
  </div>
  <div class='stat-box'>
    <span class='stat-num'>{ppd["total_sessions"]}</span>
    <span class='stat-label'>total sessions<br><span style='font-size:9px'>({PPD_WINDOW_HOURS}h window)</span></span>
  </div>
</div>

<div class='health-section'>
  <h3>⚑ Ping-Pong Alerts (PPD)</h3>
  <p class='dim health-note'>
    同一ペア間 {PPD_WINDOW_HOURS}h 窓内で往復 ≥{PPD_WARN_ROUNDS}回 を検出。
    Warning(≥{PPD_WARN_ROUNDS}) / Critical(≥{PPD_CRITICAL_ROUNDS}) / Severe(≥{PPD_SEVERE_ROUNDS})。
    Phase 1: artifact チェックなし（純メッセージ分析）。
  </p>
  {ppd_table}
</div>

<div class='health-section'>
  <h3>⬆ Escalation Quality Score (EQS)</h3>
  <p class='dim health-note'>
    エスカレーションシグナルを含むメッセージの品質スコア（宛先・送信者不問）。
    GO 系返答の割合（過剰 or 不足）を検出。
  </p>
  {eqs_html}
</div>
</div>"""


# ============================================================
# Causal Tree view: caused_by ツリー可視化 (= issue #166 活用)
# ============================================================

def _render_tree_node(msg_id, messages_map, children_map, depth=0):
    """ツリーノード 1 個を <details>/<summary> で HTML 化（再帰）。

    depth ≥ 10 で打ち切り（循環 / 深過ぎる chain への安全対策）。
    depth == 0 のルートノードは open 属性を付与して初期展開する。
    """
    if depth > 10:
        return "<div class='tree-leaf' style='padding:4px 0;font-size:10px'>…（省略）</div>"
    msg = messages_map.get(msg_id)
    if not msg:
        return ""

    preview = msg["body"][:80] + "…" if len(msg["body"]) > 80 else msg["body"]
    ts = msg["created_at"][:16].replace("T", " ") if msg.get("created_at") else ""
    children = children_map.get(msg_id, [])

    hdr = (
        f"<span class='tree-sender'>{esc(msg['sender'])}</span>"
        f" → <span class='tree-recipient'>{esc(msg['recipient'])}</span>"
        f" &nbsp;<span class='tree-body'>{esc(preview)}</span>"
        f"<span class='tree-time'>{esc(ts)}</span>"
    )

    if children:
        n = len(children)
        lbl = f"({n} repl{'ies' if n > 1 else 'y'})"
        inner = "".join(
            _render_tree_node(c, messages_map, children_map, depth + 1)
            for c in children
        )
        open_attr = " open" if depth == 0 else ""
        return (
            f"<details class='tree-item'{open_attr}>"
            f"<summary class='tree-node'>{hdr}"
            f" <span class='dim' style='font-size:10px'>{lbl}</span></summary>"
            f"<div class='tree-children'>{inner}</div>"
            f"</details>"
        )

    return f"<div class='tree-node tree-leaf'>{hdr}</div>"


def get_causal_tree_data(limit=30, agent=None, from_date=None, to_date=None, sort="size"):
    """caused_by ツリーデータを message_causes + messages テーブルから取得。

    Args:
        limit:     取得スレッド数 (最大 100)。
        agent:     フィルタ: 指定 handle が sender/recipient のスレッドのみ。
        from_date: フィルタ: thread_start >= from_date (ISO日付 e.g. "2026-05-01")。
        to_date:   フィルタ: thread_start <= to_date (ISO日付)。
        sort:      並び順: "size" (デフォルト) / "newest" / "oldest"。

    Returns:
        dict: {
          threads: list of {root_id, root_msg, thread_size,
                            thread_start, thread_end,
                            messages_map, children_map},
          total_threads: int
        }
    """
    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()

    # ------------------------------------------------------------------
    # 動的 WHERE 句の構築 (SQLインジェクション防止: ? プレースホルダ使用)
    # ------------------------------------------------------------------
    tenant_cond = "" if TENANT is None else "AND mc.tenant_id = ?"
    tenant_params: list = [] if TENANT is None else [TENANT]

    # agent フィルタ: そのスレッド内に sender/recipient として登場するか
    agent_name = None
    if agent:
        agent_name = agent if agent.startswith("@") else f"@{agent}"
    agent_cond = ""
    agent_params: list = []
    if agent_name:
        agent_cond = (
            """AND mc.root_message_id IN (
               SELECT mc2.root_message_id
               FROM message_causes mc2
               JOIN messages m2 ON m2.id = mc2.message_id
                 {tenant_join}
               WHERE mc2.position = 0
                 {tenant_cond2}
                 AND (m2.sender = ? OR m2.recipient = ?)
            )"""
        )
        if TENANT is None:
            agent_cond = agent_cond.format(
                tenant_join="",
                tenant_cond2="",
            )
            agent_params = [agent_name, agent_name]
        else:
            agent_cond = agent_cond.format(
                tenant_join="AND m2.tenant_id = mc2.tenant_id",
                tenant_cond2="AND mc2.tenant_id = ?",
            )
            agent_params = [TENANT, agent_name, agent_name]

    # ORDER BY 句
    order_map = {
        "newest": "thread_start DESC",
        "oldest": "thread_start ASC",
        "size":   "thread_size DESC",
    }
    order_clause = order_map.get(sort, "thread_size DESC")

    # ------------------------------------------------------------------
    # HAVING 句で日付範囲フィルタ (集計後に適用) — count / list 共通
    # ------------------------------------------------------------------
    having_parts = []
    having_params: list = []
    if from_date:
        having_parts.append("thread_start >= ?")
        having_params.append(from_date)
    if to_date:
        # to_date は末日の 23:59:59.999Z まで含める (ISO 準拠)
        having_parts.append("thread_start <= ?")
        having_params.append(to_date + "T23:59:59.999Z")
    having_clause = ("HAVING " + " AND ".join(having_parts)) if having_parts else ""

    # ------------------------------------------------------------------
    # 全スレッド数 (日付フィルタを含む)
    # ------------------------------------------------------------------
    count_sql = f"""
        SELECT COUNT(*) FROM (
            SELECT mc.root_message_id, MIN(m.created_at) AS thread_start
            FROM message_causes mc
            JOIN messages m ON m.id = mc.message_id
              {'AND m.tenant_id = mc.tenant_id' if TENANT else ''}
            WHERE mc.position = 0
              {tenant_cond}
              {agent_cond}
            GROUP BY mc.root_message_id
            {having_clause}
        )
    """
    count_params = tenant_params + agent_params + having_params
    cur.execute(count_sql, count_params)
    total_threads = (cur.fetchone() or (0,))[0]

    # ------------------------------------------------------------------
    # スレッド一覧取得
    # ------------------------------------------------------------------

    list_sql = f"""
        SELECT mc.root_message_id,
               COUNT(*) AS thread_size,
               MIN(m.created_at) AS thread_start,
               MAX(m.created_at) AS thread_end
        FROM message_causes mc
        JOIN messages m ON m.id = mc.message_id
          {'AND m.tenant_id = mc.tenant_id' if TENANT else ''}
        WHERE mc.position = 0
          {tenant_cond}
          {agent_cond}
        GROUP BY mc.root_message_id
        {having_clause}
        ORDER BY {order_clause}
        LIMIT ?
    """
    list_params = tenant_params + agent_params + having_params + [limit]
    cur.execute(list_sql, list_params)
    thread_meta = cur.fetchall()
    threads = []

    for root_id, thread_size, thread_start, thread_end in thread_meta:
        # ルートメッセージ詳細
        if TENANT is None:
            cur.execute(
                "SELECT id, sender, recipient, body, created_at "
                "FROM messages WHERE id = ?",
                (root_id,),
            )
        else:
            cur.execute(
                "SELECT id, sender, recipient, body, created_at "
                "FROM messages WHERE id = ? AND tenant_id = ?",
                (root_id, TENANT),
            )
        root_row = cur.fetchone()
        if not root_row:
            continue  # ルート message が見つからない（孤立 cause entry）

        root_msg = {
            "id": root_row[0], "sender": root_row[1],
            "recipient": root_row[2], "body": root_row[3],
            "created_at": root_row[4],
        }

        # スレッド内全返信（parent 情報付き）
        if TENANT is None:
            cur.execute(
                """
                SELECT m.id, m.sender, m.recipient, m.body, m.created_at,
                       mc.caused_by_id
                FROM messages m
                JOIN message_causes mc ON m.id = mc.message_id
                WHERE mc.root_message_id = ? AND mc.position = 0
                ORDER BY m.created_at ASC
                """,
                (root_id,),
            )
        else:
            cur.execute(
                """
                SELECT m.id, m.sender, m.recipient, m.body, m.created_at,
                       mc.caused_by_id
                FROM messages m
                JOIN message_causes mc
                  ON m.id = mc.message_id AND m.tenant_id = mc.tenant_id
                WHERE mc.root_message_id = ? AND mc.position = 0
                  AND mc.tenant_id = ?
                ORDER BY m.created_at ASC
                """,
                (root_id, TENANT),
            )

        messages_map = {root_id: root_msg}
        children_map: dict[str, list] = defaultdict(list)
        for row in cur.fetchall():
            mid, sender, recip, body, created_at, parent_id = row
            messages_map[mid] = {
                "id": mid, "sender": sender, "recipient": recip,
                "body": body, "created_at": created_at,
            }
            if parent_id:
                children_map[parent_id].append(mid)

        threads.append({
            "root_id":      root_id,
            "root_msg":     root_msg,
            "thread_size":  thread_size,
            "thread_start": thread_start,
            "thread_end":   thread_end,
            "messages_map": messages_map,
            "children_map": dict(children_map),
        })

    con.close()
    return {"threads": threads, "total_threads": total_threads}


def get_thread_data(thread_id):
    """1 スレッドの全メッセージを時系列フラットで取得 (issue #181 読みページ用)。

    Args:
        thread_id: root_message_id (= `?thread=<id>` の値)。
            NOTE: child メッセージ ID を渡した場合はスレッドが見つからず None を返す。
            MCP get_thread は root/child 両対応だが、dashboard は root ID のみ受け付ける
            非対称仕様。UI リンクは常に root_id を使うため実運用上は問題ないが、
            URL 手入力時はサイレント失敗する点に注意 (TODO: root 解決ロジック追加)。

    Returns:
        dict: {
          root_msg: root message dict or None,
          messages: list of dicts (root 含む、時系列昇順),
          thread_size: int
        }
        スレッドが見つからない場合は None を返す。
    """
    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()

    # root message
    if TENANT is None:
        cur.execute(
            "SELECT id, sender, recipient, body, created_at FROM messages WHERE id = ?",
            (thread_id,),
        )
    else:
        cur.execute(
            "SELECT id, sender, recipient, body, created_at "
            "FROM messages WHERE id = ? AND tenant_id = ?",
            (thread_id, TENANT),
        )
    root_row = cur.fetchone()
    if not root_row:
        con.close()
        return None

    root_msg = {
        "id": root_row[0], "sender": root_row[1], "recipient": root_row[2],
        "body": root_row[3], "created_at": root_row[4], "caused_by": None,
    }

    # スレッド内全返信 (caused_by 付き)
    if TENANT is None:
        cur.execute(
            """
            SELECT m.id, m.sender, m.recipient, m.body, m.created_at, mc.caused_by_id
            FROM messages m
            JOIN message_causes mc ON m.id = mc.message_id
            WHERE mc.root_message_id = ? AND mc.position = 0
            ORDER BY m.created_at ASC
            """,
            (thread_id,),
        )
    else:
        cur.execute(
            """
            SELECT m.id, m.sender, m.recipient, m.body, m.created_at, mc.caused_by_id
            FROM messages m
            JOIN message_causes mc
              ON m.id = mc.message_id AND m.tenant_id = mc.tenant_id
            WHERE mc.root_message_id = ? AND mc.position = 0 AND mc.tenant_id = ?
            ORDER BY m.created_at ASC
            """,
            (thread_id, TENANT),
        )
    replies = [
        {
            "id": r[0], "sender": r[1], "recipient": r[2],
            "body": r[3], "created_at": r[4], "caused_by": r[5],
        }
        for r in cur.fetchall()
    ]
    con.close()

    all_msgs = [root_msg] + replies
    return {"root_msg": root_msg, "messages": all_msgs, "thread_size": len(all_msgs)}


def render_causal_tree(agent=None, from_date=None, to_date=None, sort="size", limit=30):
    """Causal Tree view (= /?view=causaltree) の body HTML を build。

    caused_by チェーンを message_causes.root_message_id で O(1) に取得し、
    <details>/<summary> でツリー展開表示する。
    フィルタバー (agent / from / to / sort / limit) を先頭に表示。
    各スレッド行に「Read →」リンクを追加 (= /?view=causaltree&thread=<id>)。
    外部 JS 不要、stdlib のみ。

    issue #181: フィルタ対応 + 読みページリンク追加。
    """
    data = get_causal_tree_data(
        limit=limit, agent=agent, from_date=from_date, to_date=to_date, sort=sort
    )
    threads = data["threads"]
    total = data["total_threads"]

    # ------------------------------------------------------------------
    # フィルタバー (GET フォーム)
    # ------------------------------------------------------------------
    sort_options = "".join(
        f"<option value='{v}'{' selected' if sort == v else ''}>{lbl}</option>"
        for v, lbl in [("size", "size ↓"), ("newest", "newest first"), ("oldest", "oldest first")]
    )
    limit_options = "".join(
        f"<option value='{v}'{' selected' if str(limit) == str(v) else ''}>{v}</option>"
        for v in [10, 20, 30, 50, 100]
    )
    filter_bar = (
        "<form method='get' action='/' class='ct-filter-bar'>"
        "<input type='hidden' name='view' value='causaltree'>"
        f"<label>agent <input type='text' name='agent' value='{esc_attr(agent or '')}'"
        f" placeholder='@alice' style='width:100px'></label>"
        f"<label>from <input type='date' name='from' value='{esc_attr(from_date or '')}'></label>"
        f"<label>to <input type='date' name='to' value='{esc_attr(to_date or '')}'></label>"
        f"<label>sort <select name='sort'>{sort_options}</select></label>"
        f"<label>limit <select name='limit'>{limit_options}</select></label>"
        "<button type='submit' class='ct-filter-apply'>Apply</button>"
        "<a href='/?view=causaltree' class='ct-filter-reset'>Reset</a>"
        "</form>"
    )

    if not threads:
        return (
            "<div class='view-content'><h2>📎 Causal Tree</h2>"
            + filter_bar
            + "<p class='dim' style='margin-top:12px'>該当するスレッドがありません。</p>"
            "<p class='dim health-note'>"
            "send_message の <code>caused_by</code> パラメータを使うとスレッドが形成されます。"
            "</p></div>"
        )

    items = []
    for t in threads:
        root = t["root_msg"]
        preview = root["body"][:80] + "…" if len(root["body"]) > 80 else root["body"]
        start_s = t["thread_start"][:16].replace("T", " ") if t["thread_start"] else ""
        read_url = f"/?view=causaltree&thread={esc_attr(t['root_id'])}"

        # ルートから全子孫を再帰展開
        tree_html = _render_tree_node(
            t["root_id"], t["messages_map"], t["children_map"]
        )

        items.append(
            f"<details class='thread-item'>"
            f"<summary style='cursor:pointer;list-style:none;display:flex;"
            f"align-items:baseline;gap:8px;padding:10px 12px;"
            f"background:var(--bg2);border:1px solid var(--border);"
            f"border-radius:6px;margin-bottom:2px'>"
            f"<span style='font-size:16px;font-weight:bold;color:var(--accent);"
            f"min-width:2ch;text-align:right'>{t['thread_size']}</span>"
            f"<span class='dim' style='font-size:10px'>msgs</span>"
            f"<span class='tree-sender'>{esc(root['sender'])}</span>"
            f"<span class='dim'>→</span>"
            f"<span>{esc(root['recipient'])}</span>"
            f"<span class='dim' style='flex:1;overflow:hidden;text-overflow:ellipsis;"
            f"white-space:nowrap;font-size:11px'>{esc(preview)}</span>"
            f"<span class='dim' style='font-size:10px;white-space:nowrap'>{esc(start_s)}</span>"
            f"<a href='{read_url}' class='ct-read-link' onclick='event.stopPropagation()'>Read →</a>"
            f"</summary>"
            f"<div style='padding:10px 0 6px 28px;border-left:2px solid var(--border);"
            f"margin:2px 0 10px 20px'>"
            f"{tree_html}"
            f"</div>"
            f"</details>"
        )

    showing = len(threads)
    more = f" (showing {showing} of {total})" if total > showing else f" ({total} threads)"
    stats_html = (
        f"<div class='detail-stats' style='margin-bottom:20px'>"
        f"<div class='stat-box'>"
        f"<span class='stat-num'>{total}</span>"
        f"<span class='stat-label'>total threads</span></div>"
        f"<div class='stat-box'>"
        f"<span class='stat-num'>{threads[0]['thread_size'] if threads else 0}</span>"
        f"<span class='stat-label'>largest thread<br>"
        f"<span style='font-size:9px'>messages</span></span></div>"
        f"</div>"
    )

    return (
        "<div class='view-content'>"
        "<h2>📎 Causal Tree</h2>"
        "<p class='dim health-note'>"
        "caused_by チェーンから再構成したタスクスレッド。"
        "<code>root_message_id</code> による O(1) スレッド取得（issue #166）。</p>"
        + filter_bar
        + stats_html
        + f"<h3 style='font-size:12px;color:var(--text2);text-transform:uppercase;"
        f"letter-spacing:0.08em;margin-bottom:8px'>Threads{esc(more)}</h3>"
        + "".join(items)
        + "</div>"
    )


def render_thread_detail(thread_id):
    """スレッド詳細読みページ (= /?view=causaltree&thread=<id>) の body HTML。

    全メッセージをフラット時系列で表示する最小読みページ (issue #181 MVP)。
    M3 (Conversation Stream polished) の基礎となる。
    外部 JS 不要、stdlib のみ。
    """
    data = get_thread_data(thread_id)

    back_url = "/?view=causaltree"

    if data is None:
        return (
            "<div class='view-content'>"
            "<div class='thread-detail-header'>"
            f"<a href='{back_url}' class='thread-detail-back'>← Causal Tree</a>"
            "<h2 style='color:var(--accent)'>📎 Thread</h2>"
            "</div>"
            "<p class='dim'>スレッドが見つかりません。</p>"
            "</div>"
        )

    root = data["root_msg"]
    msgs = data["messages"]
    thread_size = data["thread_size"]

    # root の preview (header 用)
    root_preview = root["body"][:60] + "…" if len(root["body"]) > 60 else root["body"]
    start_ts = root["created_at"][:16].replace("T", " ") if root.get("created_at") else ""

    # メッセージリスト HTML
    msg_items = []
    for i, msg in enumerate(msgs):
        is_root = (msg["id"] == root["id"])
        ts = msg["created_at"][:16].replace("T", " ") if msg.get("created_at") else ""
        cause_html = ""
        if msg.get("caused_by"):
            cause_html = (
                f"<div class='thread-msg-cause'>↳ caused by: "
                f"<code style='font-size:10px'>{esc(msg['caused_by'][:16])}…</code></div>"
            )
        msg_items.append(
            f"<div class='thread-msg{'  thread-root' if is_root else ''}'>"
            f"<div class='thread-msg-meta'>"
            f"<span class='tree-sender'>{esc(msg['sender'])}</span>"
            f"<span class='dim'>→</span>"
            f"<span>{esc(msg['recipient'])}</span>"
            f"<span class='dim' style='margin-left:auto'>{esc(ts)}</span>"
            f"</div>"
            f"{cause_html}"
            f"<div class='thread-msg-body'>{esc(msg['body'])}</div>"
            f"</div>"
        )

    return (
        "<div class='view-content'>"
        "<div class='thread-detail-header'>"
        f"<a href='{back_url}' class='thread-detail-back'>← Causal Tree</a>"
        "<h2 style='color:var(--accent);margin:0'>📎 Thread</h2>"
        f"<span class='dim' style='font-size:11px'>"
        f"{thread_size} messages &nbsp;·&nbsp; started {esc(start_ts)}</span>"
        "</div>"
        f"<div class='dim health-note' style='margin-bottom:12px'>"
        f"<strong>{esc(root['sender'])}</strong> → {esc(root['recipient'])}"
        f" &nbsp;「{esc(root_preview)}」</div>"
        "<div class='thread-msg-list'>"
        + "".join(msg_items)
        + "</div>"
        "</div>"
    )


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        # URL routing (= 5 view: mesh / matrix / timeline / links / agent)
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        view = qs.get("view", ["mesh"])[0]
        agent_handle = qs.get("agent", [None])[0]
        # explicit agent param → Agent Detail drill-down
        if agent_handle:
            view = "agent"
        range_label = qs.get("range", ["7d"])[0]

        # Minor 1 fix (= PR #111 reviewer 指摘、 巻き取り): `?view=agent` を直接踏まれた
        # 場合 (= URL bar から手動 navigate)、 agent_handle が無いと
        # `render_agent_detail("@unknown")` が呼ばれて 「@unknown」 page が描画されて
        # しまう (= 旧 behavior、 nav state は disabled だが content は present、 state
        # inconsistency)。 本来 agent detail は drill-down view で 「mesh / link list
        # から handle を click」 が正しい動線、 直接 navigation は **不正な state** なので
        # default route (= Mesh) に redirect する。
        if view == "agent" and not agent_handle:
            self.send_response(302)
            self.send_header("Location", "/")
            self.end_headers()
            return

        try:
            # 共通 stats (= header 表示用、 全 view で fetch)
            top, counts, totals, nodes, links, total_msgs, total_agents = get_data()
        except sqlite3.OperationalError as e:
            # DB が未準備 (= initial migration 前 / volume mount 失敗等) を distinguishable
            # に return。 client 側で 「DB ready 待ち」 を判定可能に。
            self.send_response(503)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(
                f"DB not ready yet (path={DB_PATH}, tenant={TENANT}): {e}".encode("utf-8")
            )
            return

        total_links_for_header = len(links)
        try:
            if view == "agent":
                view_body = render_agent_detail(agent_handle)
                body = render_alt_view_layout(
                    "agent", view_body, total_msgs, total_agents, total_links_for_header,
                    agent_handle=agent_handle,
                )
            elif view == "matrix":
                # 2026-05-20 Mesh/Matrix 分離 (= operator follow-up)
                # matrix view は 上位 14 名に絞る (mesh view は slider で可変)
                body = render_matrix_only(
                    top[:14], counts, totals, total_msgs, total_agents, total_links_for_header,
                )
            elif view == "timeline":
                view_body = render_timeline(range_label)
                body = render_alt_view_layout(
                    "timeline", view_body, total_msgs, total_agents, total_links_for_header,
                )
            elif view == "links":
                view_body = render_link_list()
                body = render_alt_view_layout(
                    "links", view_body, total_msgs, total_agents, total_links_for_header,
                )
            elif view == "health":
                view_body = render_health()
                body = render_alt_view_layout(
                    "health", view_body, total_msgs, total_agents, total_links_for_header,
                )
            elif view == "causaltree":
                # issue #181: ?thread=<id> で詳細読みページ、なければ一覧
                thread_id = qs.get("thread", [None])[0]
                if thread_id:
                    view_body = render_thread_detail(thread_id)
                else:
                    ct_agent     = qs.get("agent", [None])[0]
                    ct_from      = qs.get("from",  [None])[0]
                    ct_to        = qs.get("to",    [None])[0]
                    ct_sort      = qs.get("sort",  ["size"])[0]
                    try:
                        ct_limit = min(max(int(qs.get("limit", ["30"])[0]), 1), 100)
                    except (ValueError, TypeError):
                        ct_limit = 30
                    view_body = render_causal_tree(
                        agent=ct_agent, from_date=ct_from, to_date=ct_to,
                        sort=ct_sort, limit=ct_limit,
                    )
                body = render_alt_view_layout(
                    "causaltree", view_body, total_msgs, total_agents, total_links_for_header,
                )
            else:
                # default (= `/` or `?view=mesh`): Mesh-only (= force-graph 単独)
                # operator DM `21df3744` の question (a) で default = Mesh と recommend、
                # 黙示同意 (= 既存 user の muscle memory + 「mesh = ecosystem first view」
                # が dashboard 全体の最も intuitive entry) として確定。
                body = render_mesh_only(
                    nodes, links, total_msgs, total_agents, total_links_for_header,
                )
        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(f"render error: {e}".encode("utf-8"))
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        # default は stderr に noisy log を出すので suppress (= docker logs を clean に)
        pass


if __name__ == "__main__":
    print(
        f"[dashboard] serving on http://0.0.0.0:{PORT} "
        f"(DB_PATH={DB_PATH}, "
        f"AGENT_HUB_TENANT={TENANT if TENANT is not None else '(unset → all tenants)'})",
        flush=True,
    )
    srv = HTTPServer(("0.0.0.0", PORT), Handler)
    srv.serve_forever()
