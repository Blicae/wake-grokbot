# Changelog

## 0.1.0 (Unreleased)

First release of the TypeScript/Node rewrite. It replaces the earlier Python prototype, which is not compatible.

- `wake-envelope/1` protocol with a JSON Schema, fixtures and docs.
- Commands: `send`, `ingest`, `status`, `ack`, `reply`, `watch`, `init`, `guide`, `doctor`.
- Idempotent sends with documented exit codes (same content: 0, different content: 7, unknown wake outcome: 6).
- Grok Bot wake channel: Bearer key, summary-only payload, redirects refused, rate caps, outbox with backoff and a dead state, coalescing, kill switch.
- Generic `script` wake channel.
- Reply sinks: `file`, `webhook` (HMAC-SHA256), `command`, `hufu-report` (report file plus `.DONE` marker).
- Agent skill at `skills/wake-grokbot/SKILL.md`.
