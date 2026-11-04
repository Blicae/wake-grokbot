# Roadmap and comparison

Compared in November 2026 with public projects that wake or bridge agents (Grok Bot relays and gateways,
Claude Code bridges, A2A bridges, team agent inboxes, desktop orchestrators).

## Shipped in 0.1.0

Inbox + receipts, `wake-envelope/1` with schema, idempotent sends with exit codes, coalescing (one wake in
flight per target), `release` (the run is finished, send what queued), outbox with backoff, dead state and
hourly caps, kill switch, signed envelopes, four reply sinks, `doctor --dry-run`, JSON log lines, `prune`,
Claude Code Stop hook example, BOOTSTRAP for agents, release workflow with npm provenance.

## Later

- **MCP server mode** (`wake-grokbot mcp`, stdio): tools `send`, `status`, `ack`, `reply`, `list_unread` so
  an agent calls them directly. Needs a JSON-RPC stdio loop; doable without dependencies, but the tool
  surface should settle first.
- **Push into a live Claude Code session** (Claude Code channels). Still a research preview; the inbox plus
  a Stop hook covers the need today.
- **Attachments by reference**: `attachments: [{name, path, sha256, bytes}]` inside the inbox, for large
  results. Protocol addition, needs schema + fixtures.
- **Ticket expiry**: optional `expires_at`; `status` and `watch` mark expired tasks; `prune` removes them.
- **A2A mapping doc**: map our statuses to A2A task states (`working`, `input-required`, `completed`,
  `failed`, `canceled`, `rejected`) so an A2A bridge can sit in front.
- **Rate-limit hint**: if a wake target answers HTTP 400/429 with a rate-limit message, back off longer.

## Not planned

- Reading another app's sessions, keychains or internal gateways to send messages. Wakes go only through
  the documented webhook with a key the user provides.
- A hosted relay server. wake-grokbot stays a local CLI; run a relay in front if you need one.
