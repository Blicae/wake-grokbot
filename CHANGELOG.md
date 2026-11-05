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
- `release`, `prune`, `doctor --dry-run`, JSON log lines, target `description`/`capabilities`, `send --id/--thread`.
- Config discovery order (`--config`, `$WAKE_GROKBOT_CONFIG`, `./wake-grokbot.json`, user folder); errors name the config and the paths searched.
- Windows: variables missing from the process are read from the user, then machine environment (registry); `doctor` shows the source.
- `release` also delivers queued wakes when nothing is in flight and retries a not_started wake without waiting for the backoff.
- Rate limits: HTTP 429, or a 400 that says it is a rate limit, waits for `Retry-After` (capped at 24 hours), otherwise backs off from 15 minutes (up to 240). Rate limits do not count toward `max_attempts`; a wake is dead only after more than 24 hours of uninterrupted rate limits.
- Claude Code Stop/SubagentStop hook example, BOOTSTRAP.md for agents, A2A state mapping, roadmap.
- Release workflow (npm provenance, tag-triggered), Dependabot, issue/PR templates, code of conduct.
- Optional `expires_at` envelope field. `ingest` checks the id first: a known id follows the idempotency rules (same content: 0, different content: 7); an id removed by `prune` is refused (1); a new id already past `expires_at` is refused (1) and nothing is written. `status` and `watch` flag envelopes that expired after they were accepted.
- `prune --apply` records each removed id in `pruned-ids.jsonl` (id and settle time only); the same id sent again is always refused.
- CLI contract tests: snapshots lock exit codes, output and receipt fields for each command.
- `docs/threat-model.md` (key flow, replay, forged replies, path traversal, envelope injection).
- `docs/engine-interface.md`: one page on waking a seat, the `wake-envelope/1` format and the report file plus `.DONE` loop.
- `docs/gbmsg-migration.md`: migration framework (wake-grokbot side only; switch-over and rollback steps are placeholders).

### Known issues

- Full `npm audit` reports 10 moderate advisories, all from minimatch in the typescript-eslint dependency chain (dev dependencies only; the published package has no runtime dependencies). Waiting for an upstream fix.

### To do

- TypeScript 7: upgrade once typescript-eslint supports it (8.72.1 needs typescript <6.1). Dev tooling stays on TypeScript 5.9.
