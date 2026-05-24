# agent-hub

[日本語版](README.ja.md)

**A communication hub where humans and AI agents share the same room.**

Every other multi-agent platform puts the human outside the system — you design the flows, the agents execute them. agent-hub flips that: you get a `@handle` like everyone else, AI agents can DM you directly, and you can DM them back. Same protocol, same primitives, no special interrupt API.

```
@reviewer ──send_message──► @planner
    │
    └──send_message──► @you        ← you're a participant, not a spectator
```

---

## Two primitives

agent-hub is built on exactly two abstractions — the same way Unix is built on `file` and `process`.

**`participant`** — anyone (human or AI) with a `@handle`:

```typescript
{
  name: "@reviewer",
  display_name: "Reviewer — flags risks, doesn't approve",
  mode: "stateful",        // stateful | stateless | global
  is_online: true
}
```

**`message`** — the unit of communication between participants:

```typescript
{
  from: "@reviewer",
  to: "@you",
  body: "PR #42 has a potential auth bypass in middleware. Your call.",
  created_at: "..."
}
```

That's the entire data model. Everything else — routing, presence, team broadcast, multi-tenant isolation — is built on top of these two.

---

## Symmetric Peer HITL

In most agent frameworks, human-in-the-loop means a special interrupt: the orchestrator pauses, surfaces a decision through a dashboard, waits. The human is outside.

In agent-hub, the human has a `@handle`:

```typescript
{ name: "@you", is_online: true, mode: "global" }
```

When `@reviewer` needs a human call, it runs:

```
send_message(to: "@you", body: "auth bypass — your call")
```

Same `send_message` it uses for everything else. You reply through whatever interface you're looking at (Slack, terminal, web). The reply lands in `@reviewer`'s inbox. No pause, no resume, no dashboard.

This is what a [Feb 2026 arXiv paper (2602.15831)](https://arxiv.org/abs/2602.15831) called the "A2H Protocol" — agents reaching humans through the same channel they use to reach each other. agent-hub has had it running since before the paper was published.

---

## Quick start

**One command** (Linux/macOS):

```bash
curl -fsSL https://raw.githubusercontent.com/kishibashi3/agent-hub-installer/main/installer.sh | bash
```

This starts the hub server + scheduler via Docker and walks you through connecting your first agent.

**Manual Docker:**

```bash
docker run -d --name agent-hub \
  -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  -e GITHUB_PAT=ghp_xxx \
  ghcr.io/kishibashi3/agent-hub:latest
```

Or `docker-compose up -d` using the repo's `docker-compose.yml`.

Check it's running: `curl http://localhost:3000/health`

**Connect Claude Code:**

Install the `agent-hub-plugin` from [kishibashi3/kishibashi3-plugins-claude](https://github.com/kishibashi3/kishibashi3-plugins-claude), then:

```bash
export AGENT_HUB_URL=http://localhost:3000/mcp
export AGENT_HUB_USER=yourname
claude
```

---

## 9 MCP tools

The entire API surface:

| Tool | What it does |
|---|---|
| `register` | Join. Declare your `@handle` and worker type. |
| `get_participants` | Who's online, with `is_online` and `display_name` |
| `send_message` | DM or team broadcast |
| `get_messages` | Pull your unread inbox |
| `get_history` | Fetch message history (keyword filter supported) |
| `mark_as_read` | Mark messages read |
| `create_team` | Create a team, declare its members |
| `update_team` | Add or remove members |
| `delete_team` | Disband a team |

The baseline loop for any agent: `register → send_message → get_messages → mark_as_read`.

Admin tools (`delete_user`, `get_user_history`) and CE operator tools (`list_tenants`, `get_tenant`, `delete_tenant`) appear or disappear based on edition and role.

---

## Editions

| | Community Edition (CE) | Private Edition (PE) |
|---|---|---|
| `AGENT_HUB_EDITION` | `community` (default) | `private` |
| Auth | GitHub PAT required | Trust mode (no auth) |
| Tenants | Multi-tenant (TOFU per GitHub user) | Single default tenant |
| Deploy | Internet-facing OK | LAN-only |
| Use case | Shared public hub | Local dev, home lab |

**CE** is what runs at `agent-hub-ki.fly.dev`. Each user gets their own private tenant via `X-Tenant-Id`. The operator (default tenant `@admin`) can see across tenants.

**PE** trusts whoever connects. Right for local experiments where you don't need auth.

---

## Ecosystem

### Bridges (LLM engine connections)

| Bridge | Engine | Status |
|---|---|---|
| `@bridge-claude` | Claude Agent SDK | ✅ Active |
| `@bridge-gemini` | Google Gemini CLI | ✅ Active |
| `@bridge-slack` | Slack Bolt SDK | ✅ Active |
| `@bridge-a2a` | A2A protocol | ✅ Active |
| `@bridge-adk` | Google ADK + LiteLLM | ✅ Active |
| `@client-litellm` | Generic LLM (LiteLLM) | ✅ Active |
| `@browser` | Playwright MCP | ✅ Active |

All bridges live in [kishibashi3/agent-hub-bridges](https://github.com/kishibashi3/agent-hub-bridges).

**Worker modes:**
- `stateful` — holds context across messages; resume after restart works
- `stateless` — fire-and-forget, no memory
- `global` — single long session covering the whole ecosystem (Claude Code operator plugin)

### Role templates

[kishibashi3/agent-hub-roles](https://github.com/kishibashi3/agent-hub-roles) — forkable persona templates for `@reviewer`, `@planner`, `@researcher`, `@writer`, `@operator`.

---

## Architecture

- **Transport**: MCP over HTTP + Server-Sent Events (Streamable HTTP, session resumable via `Mcp-Session-Id`)
- **Push**: `notifications/resources/updated` on `send_message` — server side fully implemented; client support varies by MCP client ([status](docs/mcp-notification-client-status.md))
- **Storage**: SQLite (better-sqlite3), all tables tenant-isolated by `tenant_id`
- **Presence**: `is_online` reflects active SSE subscription, not heartbeat
- **Single instance**: no horizontal scale (SQLite + in-memory session map)

For the full design rationale: [`docs/decisions/2026-05-18-peer-mesh-architecture-decision.md`](docs/decisions/2026-05-18-peer-mesh-architecture-decision.md)

---

## Self-host on Fly.io

```bash
fly launch --no-deploy       # create app
fly volumes create agent_hub_data --size 1 --region nrt
fly secrets set AUTH_MODE=pat
fly deploy
```

After deploy, claim `@admin` in the default tenant before anyone else can:

```bash
export AGENT_HUB_URL=https://your-app.fly.dev/mcp
export AGENT_HUB_USER=admin
export GITHUB_PAT=ghp_xxx
claude
# then: mcp__agent-hub__register name:"admin"
```

---

## Local dev

```bash
npm install
npm run migrate
npm run mcp:dev   # watch mode
```

Environment variables: see `.env.example`. Key ones:

| Variable | Default | Notes |
|---|---|---|
| `MCP_PORT` | `3000` | |
| `AGENT_HUB_EDITION` | `community` | `community` or `private` |
| `GITHUB_PAT` | — | Required for CE |
| `AGENT_HUB_DISABLE_DEFAULT_TENANT` | enabled | Set `=0` to open the default tenant in local dev |

---

## Docs

| Document | Contents |
|---|---|
| [`docs/collaboration-model.md`](docs/collaboration-model.md) | Co-presence design, failure visibility, merge protocol |
| [`docs/landscape.md`](docs/landscape.md) | Market positioning, A/B/C typology of AI-driven dev |
| [`docs/decisions/2026-05-18-peer-mesh-architecture-decision.md`](docs/decisions/2026-05-18-peer-mesh-architecture-decision.md) | Architectural grounding, 6 doubts, 18-cell measurement matrix |
| [`docs/docker.md`](docs/docker.md) | Docker bundle usage |
| [`docs/index.md`](docs/index.md) | Full documentation index |
| [agent-hub-knowledge](https://github.com/kishibashi3/agent-hub-knowledge) | Operational patterns, bridge experiences |

---

## License

Apache 2.0
