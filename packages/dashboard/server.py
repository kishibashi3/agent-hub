#!/usr/bin/env python3
"""
agent-hub dashboard sidecar (= admin feature request、 2026-05-20)

agent-hub server の SQLite DB を read-only mount + 単一 SELECT クエリで集計、
D3.js force-directed graph + message matrix heatmap として可視化する
軽量 sidecar Python サーバー。 stdlib のみ (sqlite3 + http.server) で動作、
外部 deps なし。

設計: @admin (Pi5 ops) が Pi5 上で運用していた `/home/admin/agent-hub-heatmap/server.py`
の同等実装を packages/dashboard/ 配下に取り込み、 Docker bundle 化に追従。
変更点 (= admin spec):
- DB_PATH を env 化 (= shared volume mount に追従、 hardcode 撤廃)
- AGENT_HUB_TENANT を env 化:
  - 値 set → 当該 tenant のみ表示 (= 旧 Pi5 spec の "kaz" 固定相当)
  - 未指定 → **全 tenant aggregate** 表示 (= admin 確認済の default 挙動)
- PORT を env 化 (= compose 経由の port 設定柔軟化)

DB は SELECT only、 SQLite WAL mode で agent-hub server (= writer) と
並行 read 安全。 docker-compose 側で `:ro` (read-only) mount を強制。

multi-tenant aggregate (= TENANT 未指定時) の注意:
- 同名 handle が複数 tenant に存在する場合、 全 tenant の activity が
  同 node に合算される (= 異なる entity が同じ handle name を共有していた場合、
  dashboard 上は 1 つに見える)
- これは dashboard の 「ecosystem 全体の traffic view」 用途として acceptable、
  per-tenant の forensic 用途は AGENT_HUB_TENANT 明示 set で利用想定
"""

import os
import sqlite3
import json
from http.server import HTTPServer, BaseHTTPRequestHandler

# admin spec (= 2026-05-20): env 化 3 fields
DB_PATH = os.environ.get("DB_PATH", "/app/data/app.db")
# TENANT 未指定 → 全 tenant aggregate (= admin clarification 受領)。
# set されていれば当該 tenant のみ filter。
TENANT = os.environ.get("AGENT_HUB_TENANT") or None
PORT = int(os.environ.get("PORT", "8080"))


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

    top = sorted(totals, key=lambda x: -totals[x])[:14]
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
</style>
</head>
<body>

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
    tenant: TENANT_LABEL &nbsp;|&nbsp; reload で最新取得
    <button id="theme-btn" onclick="toggleTheme()">🌙 dark</button>
  </div>
</div>

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

<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
<script>
const nodes = NODES_JSON;
const links = LINKS_JSON;

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

const pane = document.getElementById('graph-pane');
const w = pane.offsetWidth, h = pane.offsetHeight;
const svg = d3.select('#svg').attr('viewBox', [0, 0, w, h]);

// ── SVG defs: glow filters + radial gradients per color ──────────────────
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

// radial gradient per node
nodes.forEach(d => {
  const c = roleColor(d.id);
  const grad = defs.append('radialGradient')
    .attr('id', 'g-' + d.id.replace(/[@-]/g,'_'))
    .attr('cx','35%').attr('cy','35%').attr('r','65%');
  grad.append('stop').attr('offset','0%').attr('stop-color','#fff').attr('stop-opacity','0.35');
  grad.append('stop').attr('offset','50%').attr('stop-color', c).attr('stop-opacity','1');
  grad.append('stop').attr('offset','100%').attr('stop-color', d3.color(c).darker(1.2)).attr('stop-opacity','1');
});

const maxTotal = d3.max(nodes, d => d.total);
const maxVal   = d3.max(links, d => d.value);
const rScale = d3.scaleSqrt().domain([0, maxTotal]).range([6, 32]);
const wScale = d3.scaleSqrt().domain([0, maxVal]).range([0.8, 6]);
const opacityScale = d3.scaleLinear().domain([0, maxVal]).range([0.25, 0.85]);

const sim = d3.forceSimulation(nodes)
  .force('link', d3.forceLink(links).id(d => d.id).distance(d => 120 - wScale(d.value) * 3).strength(0.35))
  .force('charge', d3.forceManyBody().strength(-380))
  .force('center', d3.forceCenter(w / 2, h / 2))
  .force('collision', d3.forceCollide().radius(d => rScale(d.total) + 12));

const g = svg.append('g');

// curved edges as <path>
const link = g.append('g').selectAll('path').data(links).join('path')
  .attr('fill', 'none')
  .attr('stroke', d => roleColor(d.source.id || d.source))
  .attr('stroke-opacity', d => opacityScale(d.value))
  .attr('stroke-width', d => wScale(d.value))
  .attr('filter', 'url(#edge-glow)');

const node = g.append('g').selectAll('g').data(nodes).join('g')
  .call(d3.drag()
    .on('start', (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
    .on('drag',  (e, d) => { d.fx = e.x; d.fy = e.y; })
    .on('end',   (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));

// diamond points helper
const diamond = r => `0,${-r} ${r},0 0,${r} ${-r},0`;

function addInteraction(sel) {
  sel.on('mouseover', (e, d) => {
      d3.select(e.currentTarget).attr('stroke-opacity', 1).attr('stroke-width', 2);
      const tip = document.getElementById('tooltip');
      const myLinks = links.filter(l => l.source.id === d.id || l.target.id === d.id);
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

sim.on('tick', () => {
  link.attr('d', arcPath);
  node.attr('transform', d => `translate(${d.x},${d.y})`);
});

// drift speed slider
const speedSlider = document.getElementById('drift-speed');
const speedVal    = document.getElementById('drift-val');
speedSlider.addEventListener('input', () => { speedVal.textContent = speedSlider.value; });

let drifting = true;
setInterval(() => {
  if (!drifting) return;
  const s = parseFloat(speedSlider.value);
  if (s === 0) return;
  nodes.forEach(d => {
    if (d.fx != null) return;
    d.vx = (d.vx || 0) + (Math.random() - 0.5) * s * 0.2;
    d.vy = (d.vy || 0) + (Math.random() - 0.5) * s * 0.2;
  });
  sim.alpha(Math.max(sim.alpha(), s * 0.015)).restart();
}, 1000);

svg.on('mousedown', () => { drifting = false; })
   .on('mouseup',   () => { setTimeout(() => { drifting = true; }, 800); });

svg.call(d3.zoom().scaleExtent([0.3, 4])
  .on('zoom', e => g.attr('transform', e.transform)));

// resizable divider
(function() {
  const div = document.getElementById('divider');
  const hm  = document.getElementById('heatmap-pane');
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
    """sender × recipient ヒートマップ HTML を build。

    cell 色は msg count 比率で gradient、 self cell (= s==r) は dim。
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
        lines.append(f"<th>{r[1:][:8]}</th>")
    lines.append("<th class='tc'>tot</th></tr>")

    for s in top:
        lines.append("<tr>")
        lines.append(f"<th class='rl'>{s}</th>")
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
                    f"data-n='{n}' data-from='{s}' data-to='{r}'>{label}</td>"
                )
        lines.append(f"<td class='tc'>{totals[s]}</td>")
        lines.append("</tr>")
    lines.append("</table>")
    return "\n".join(lines)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            top, counts, totals, nodes, links, total_msgs, total_agents = get_data()
        except sqlite3.OperationalError as e:
            # DB が未準備 (= initial migration 前 / volume mount 失敗等) を distinguishable
            # に return。 client 側で 「DB ready 待ち」 を判定可能に。
            self.send_response(503)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(
                f"DB not ready yet (path={DB_PATH}, tenant={TENANT}): {e}".encode(
                    "utf-8"
                )
            )
            return
        heatmap_html = build_heatmap(top, counts, totals)
        body = (
            HTML.replace("NODES_JSON", json.dumps(nodes))
            .replace("LINKS_JSON", json.dumps(links))
            .replace("HEATMAP_HTML", heatmap_html)
            .replace("TOTAL_MSGS", str(total_msgs))
            .replace("TOTAL_AGENTS", str(total_agents))
            .replace("TOTAL_LINKS", str(len(links)))
            .replace("TENANT_LABEL", TENANT if TENANT is not None else "all tenants")
            .encode("utf-8")
        )
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
