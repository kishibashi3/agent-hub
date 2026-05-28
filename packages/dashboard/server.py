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
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

# admin spec (= 2026-05-20): env 化 3 fields
DB_PATH = os.environ.get("DB_PATH", "/app/data/app.db")
# TENANT 未指定 → 全 tenant aggregate (= admin clarification 受領)。
# set されていれば当該 tenant のみ filter。
TENANT = os.environ.get("AGENT_HUB_TENANT") or None
PORT = int(os.environ.get("PORT", "8080"))


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
<!-- D3.js を <head> で先行 load (= 2026-05-20 timeline bug fix):
     旧位置 (= body 末尾、 mesh JS の直前) では alt view (= timeline) の inline <script>
     が D3 script tag より前に位置するため `ReferenceError: d3 is not defined` で chart
     が描画されない。 head に移動して全 view で D3 が available な状態を保証。
     defer 不要 (= mesh JS は body 末尾で `<script>` 直書きなので、 head の同期 load
     完了後にしか到達しない)。 -->
<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
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
</style>
</head>
<body class="BODY_CLASS">

<div id="header">
  <h1>agent-hub</h1>
  <div class="stat"><strong>TOTAL_MSGS</strong>messages</div>
  <div class="stat"><strong>TOTAL_AGENTS</strong>agents</div>
  <div class="stat"><strong>TOTAL_LINKS</strong>active links</div>
  <div id="header-right">
    <label style="display:flex;align-items:center;gap:6px;color:var(--text2)">
      drift
      <input id="drift-speed" type="range" min="0" max="10" value="3" step="0.5"
        style="width:80px;accent-color:var(--accent);cursor:pointer">
      <span id="drift-val" style="width:2ch;text-align:right">3</span>
    </label>
    <label style="display:flex;align-items:center;gap:6px;color:var(--text2)">
      nodes
      <input id="top-n" type="range" min="1" max="NODE_COUNT" value="NODE_DEFAULT" step="1"
        style="width:80px;accent-color:var(--accent);cursor:pointer">
      <span id="top-n-val" style="min-width:2ch;text-align:right">NODE_DEFAULT</span>
    </label>
    tenant: TENANT_LABEL &nbsp;|&nbsp; reload で最新取得
    <button id="theme-btn" onclick="toggleTheme()">🌙 dark</button>
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

<!-- D3.js は <head> で先行 load 済 (= 2026-05-20 timeline bug fix、 旧 location)。 -->
<script>
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
const svg = d3.select('#svg').attr('viewBox', [0, 0, w, h]);

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

svg.call(d3.zoom().scaleExtent([0.3, 4])
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
    grad.append('stop').attr('offset','100%').attr('stop-color', d3.color(c).darker(1.2)).attr('stop-opacity','1');
  });

  const maxTotal = d3.max(ns, d => d.total);
  const maxVal   = d3.max(ls, d => d.value);
  const rScale = d3.scaleSqrt().domain([0, maxTotal || 1]).range([6, 32]);
  const wScale = d3.scaleSqrt().domain([0, maxVal || 1]).range([0.8, 6]);
  const opacityScale = d3.scaleLinear().domain([0, maxVal || 1]).range([0.25, 0.85]);

  currentSim = d3.forceSimulation(ns)
    .force('link', d3.forceLink(ls).id(d => d.id).distance(d => 120 - wScale(d.value) * 3).strength(0.35))
    .force('charge', d3.forceManyBody().strength(-380))
    .force('center', d3.forceCenter(w / 2, h / 2))
    .force('collision', d3.forceCollide().radius(d => rScale(d.total) + 12));

  // curved edges as <path>
  const link = g.append('g').selectAll('path').data(ls).join('path')
    .attr('fill', 'none')
    .attr('stroke', d => roleColor(d.source.id || d.source))
    .attr('stroke-opacity', d => opacityScale(d.value))
    .attr('stroke-width', d => wScale(d.value))
    .attr('filter', 'url(#edge-glow)');

  const node = g.append('g').selectAll('g').data(ns).join('g')
    .call(d3.drag()
      .on('start', (e, d) => { if (!e.active) currentSim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag',  (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on('end',   (e, d) => { if (!e.active) currentSim.alphaTarget(0); d.fx = null; d.fy = null; }));

  // diamond points helper
  const diamond = r => `0,${-r} ${r},0 0,${r} ${-r},0`;

  function addInteraction(sel) {
    sel.on('mouseover', (e, d) => {
        d3.select(e.currentTarget).attr('stroke-opacity', 1).attr('stroke-width', 2);
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
        d3.select(e.currentTarget).attr('stroke-opacity', 0.6).attr('stroke-width', 1);
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

// drift speed slider
const speedSlider = document.getElementById('drift-speed');
const speedVal    = document.getElementById('drift-val');
speedSlider.addEventListener('input', () => { speedVal.textContent = speedSlider.value; });

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

// top-n slider (ノード数リアルタイム変更)
const topNSlider = document.getElementById('top-n');
const topNVal    = document.getElementById('top-n-val');
topNSlider.addEventListener('input', () => {
  const n = parseInt(topNSlider.value, 10);
  topNVal.textContent = n;
  redraw(n);
});

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

// theme toggle
function toggleTheme() {
  const dark = document.body.classList.toggle('dark');
  document.getElementById('theme-btn').textContent = dark ? '☀️ light' : '🌙 dark';
  // update edge + node text colors
  const nc = getComputedStyle(document.documentElement).getPropertyValue('--node-text').trim();
  d3.selectAll('.node text').attr('fill', nc);
}

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
<script>
const tlBuckets = {buckets_json};
const tlContainer = document.getElementById('timeline-chart');
const tlW = tlContainer.offsetWidth, tlH = tlContainer.offsetHeight;
const tlMargin = {{top: 20, right: 30, bottom: 60, left: 50}};
const tlIW = tlW - tlMargin.left - tlMargin.right;
const tlIH = tlH - tlMargin.top - tlMargin.bottom;

const tlSvg = d3.select('#timeline-chart').append('svg')
  .attr('width', tlW).attr('height', tlH)
  .append('g').attr('transform', `translate(${{tlMargin.left}},${{tlMargin.top}})`);

if (tlBuckets.length === 0) {{
  tlSvg.append('text').attr('x', tlIW/2).attr('y', tlIH/2).attr('text-anchor', 'middle')
    .attr('fill', getComputedStyle(document.documentElement).getPropertyValue('--text2').trim())
    .text('No messages in selected range');
}} else {{
  const tlX = d3.scaleBand().domain(tlBuckets.map(d => d.time)).range([0, tlIW]).padding(0.1);
  const tlY = d3.scaleLinear().domain([0, d3.max(tlBuckets, d => d.count) || 1]).range([tlIH, 0]).nice();

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
  tlSvg.append('g').call(d3.axisLeft(tlY).ticks(5));

  // X axis with rotated labels (subset)
  const tickEvery = Math.max(1, Math.floor(tlBuckets.length / 12));
  const tlXAxis = d3.axisBottom(tlX).tickValues(tlBuckets.filter((_, i) => i % tickEvery === 0).map(d => d.time));
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
<script>
(function() {{
  const agBuckets = {agent_buckets_json};
  const agRegistered = {registered};
  const agContainer = document.getElementById('agent-activity-chart');
  const agW = agContainer.offsetWidth, agH = agContainer.offsetHeight;
  const agMargin = {{top: 20, right: 30, bottom: 60, left: 50}};
  const agIW = agW - agMargin.left - agMargin.right;
  const agIH = agH - agMargin.top - agMargin.bottom;

  const agSvg = d3.select('#agent-activity-chart').append('svg')
    .attr('width', agW).attr('height', agH)
    .append('g').attr('transform', `translate(${{agMargin.left}},${{agMargin.top}})`);

  if (agBuckets.length === 0) {{
    agSvg.append('text').attr('x', agIW/2).attr('y', agIH/2).attr('text-anchor', 'middle')
      .attr('fill', getComputedStyle(document.documentElement).getPropertyValue('--text2').trim())
      .text('No agent activity in selected range');
  }} else {{
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const agX = d3.scaleBand().domain(agBuckets.map(d => d.time)).range([0, agIW]).padding(0.1);
    const yMax = Math.max(agRegistered, d3.max(agBuckets, d => d.active + d.idle) || 1);
    const agY = d3.scaleLinear().domain([0, yMax]).range([agIH, 0]).nice();

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
    agSvg.append('g').call(d3.axisLeft(agY).ticks(Math.min(yMax, 6)).tickFormat(d3.format('d')));

    // X axis
    const agTickEvery = Math.max(1, Math.floor(agBuckets.length / 12));
    const agXAxis = d3.axisBottom(agX)
      .tickValues(agBuckets.filter((_, i) => i % agTickEvery === 0).map(d => d.time));
    agSvg.append('g').attr('transform', `translate(0,${{agIH}})`).call(agXAxis)
      .selectAll('text').attr('transform', 'rotate(-45)').attr('text-anchor', 'end')
      .attr('dx', '-0.5em').attr('dy', '0.5em').attr('font-size', '10px');
  }}
}})();
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
    # Overview group (= 全体構造を見る view 群、 4 link)
    overview_items = [
        ("mesh", "Mesh", "/"),
        ("matrix", "Matrix", "/?view=matrix"),
        ("timeline", "Timeline", "/?view=timeline"),
        ("links", "Link List", "/?view=links"),
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
