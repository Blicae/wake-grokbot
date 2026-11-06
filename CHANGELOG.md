# Changelog

## 0.1.0 (Unreleased)

First release of the TypeScript/Node rewrite. It replaces the earlier Python prototype, which is not compatible.

- `wake-envelope/1` protocol with a JSON Schema, fixtures and docs.
- Commands: `send`, `ingest`, `status`, `ack`, `reply`, `watch`, `init`, `guide`, `doctor`.
- Idempotent sends with documented exit codes (same content: 0, different content: 7, unknown wake outcome: 6).
- Grok Bot wake channel: Bearer key, summary-only payload, redirects refused, rate caps, outbox with backoff and a dead state, coalescing, kill switch.
- Generic `script` wake channel.
- Reply sinks: `file`, `webhook` (HMAC-SHA256), `command`, `hufu-report` (report file plus `.DONE` marker).
- Sinks contract v1 (unreleased 0.1, **breaking for `.DONE` readers** of earlier development builds): `.DONE` is
  written only for terminal statuses (`done`, `failed`, `declined`), never for `working`/`needs_input`/`blocked`;
  its format is now `wake-report-done/1` (`format`, `id`, `status`, `at`, plus `task_id`, `revision`, `reply_hash`,
  `report_sha256` when the caller passes a task delivery). Readers must check `format` and treat only
  `status: "done"` as success. Optional `ctx.delivery` (task id, reply hash, revision) adds per-path locking,
  ownership (`<target>.wake.json`), revision ordering (`superseded`), `duplicate`/`conflict` detection and marker
  recovery; results carry `outcome` (`delivered`/`not_sent`/`unknown`) and, for file/report sinks, `state`.
  Per-path lock with owner identity (host, pid, process start, token), never stolen by age; delivery intent
  written before the report so a retry repairs its own crash windows. Webhook: only a provably unsent request
  is `not_sent`; any non-2xx answer or timeout is `unknown`. Sink types (`SinkContext`, `SinkDelivery`,
  `SinkResult`, `SinkOutcome`, `SinkState`) are exported from the package entry. Webhooks send `X-Wake-Grokbot-Delivery-Id`.
- Envelope times (`sent_at`, `quoted_at`, `expires_at`) are validated as RFC 3339 at runtime, like the schema.
- The example config no longer ships a `my-hook` webhook (a fresh `init` + `doctor` no longer warns about it).
- Install docs and scheduled-watch examples pin `wake-grokbot@0.1.0` and pass an explicit `--config`; a global install of another version is refused, never used.
- Agent skill at `skills/wake-grokbot/SKILL.md`.
- `release`, `prune`, `doctor --dry-run`, JSON log lines, target `description`/`capabilities`, `send --id/--thread`.
- Config discovery order (`--config`, `$WAKE_GROKBOT_CONFIG`, `./wake-grokbot.json`, user folder); errors name the config and the paths searched.
- Windows: variables missing from the process are read from the user, then machine environment (registry); `doctor` shows the source.
- `release` also delivers queued wakes when nothing is in flight and retries a not_started wake without waiting for the backoff.
- Rate limits: HTTP 429, or a 400 that says it is a rate limit, waits for `Retry-After` (capped at 24 hours), otherwise backs off 15, 30, 60 ... minutes, doubling up to 240. Rate limits do not count toward `max_attempts`; a wake is dead only after more than 24 hours of uninterrupted rate limits.
- Claude Code Stop/SubagentStop hook example, BOOTSTRAP.md for agents, A2A state mapping, roadmap.
- Release workflow (npm provenance, tag-triggered), Dependabot, issue/PR templates, code of conduct.
- Optional `expires_at` envelope field. `ingest` checks the id first: a known id follows the idempotency rules (same content: 0, different content: 7); an id removed by `prune` is refused (1); a new id already past `expires_at` is refused (1) and nothing is written. Only `ingest` refuses expired envelopes; `send` does not check `expires_at`, and the check is skipped when the envelope file already exists. `status` and `watch` flag envelopes that expired after they were accepted.
- `prune --apply` records each removed envelope id in `pruned-ids.jsonl` (id and settle time only; for an envelope whose receipt is missing, the file time); the same id sent again is always refused.
- CLI contract tests: snapshots lock exit codes, output and receipt fields for each command.
- `docs/threat-model.md` (key flow, replay, forged replies, path traversal, envelope injection).
- `docs/engine-interface.md`: one page on waking a seat, the `wake-envelope/1` format and the report file plus `.DONE` loop.
- `docs/gbmsg-migration.md`: migration framework (wake-grokbot side only; switch-over and rollback steps are placeholders).
- CI: ubuntu, windows and macOS × Node 22 and 24; lint, typecheck, test, build, then `scripts/check-pack.mjs` checks `npm pack --dry-run` against the `files` whitelist (and refuses secret-looking files).
- CI security job: `npm audit --omit=dev` gates on runtime dependency advisories; a full `npm audit` reports dev-only advisories without failing; zizmor scans the workflows.
- GitHub Actions: `actions/checkout` and `actions/setup-node` at v7 (v7.0.1 / v7.1.0), pinned by commit SHA, with `persist-credentials: false`.
- Crash and concurrency tests with real child processes: two processes sending at once keep ids and receipts intact; a process killed mid-send recovers as unknown and is never resent.
- Dev dependencies: eslint 10, @eslint/js 10, vitest 5; TypeScript stays on 5.9 and @types/node on 22.

### Known issues

- Full `npm audit` reports 10 moderate advisories, all from minimatch in the typescript-eslint dependency chain (dev dependencies only; the published package has no runtime dependencies). Waiting for an upstream fix.

### To do

- TypeScript 7: upgrade once typescript-eslint supports it (8.72.1 needs typescript <6.1). Dev tooling stays on TypeScript 5.9.
- `wasPruned` reads all of `pruned-ids.jsonl` on every accept; cache it in 0.1.x.
