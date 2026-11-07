# Changelog

## Unreleased

- Terminal report footer: a `done` / `failed` / `declined` report file (`hufu-report` sink) now ends with a fixed
  block: the Grok Bot account's weekly quota (passed by the woken Bot with `reply --quota-used`,
  `--quota-remaining`, `--quota-reset`, or `"quota"` in `reply --json`; `未提供` when missing), and the execution
  time computed from the ack/working receipt to the terminal reply, in 北京时间. `report_sha256` covers it.
  Non-terminal reports, the envelope and webhook/command/file sinks are unchanged. See docs/engine-interface.md.

## 0.1.0 (Unreleased)

First release of the TypeScript/Node rewrite. It replaces the earlier Python prototype, which is not compatible.

- `wake-envelope/1` protocol with a JSON Schema, fixtures and docs.
- Commands: `send`, `ingest`, `status`, `ack`, `reply`, `watch`, `init`, `guide`, `doctor`.
- Idempotent sends with documented exit codes (same content: 0, different content: 7, unknown wake outcome: 6).
- Grok Bot wake channel: Bearer key, summary-only payload, redirects refused, rate caps, outbox with backoff and a dead state, coalescing, kill switch.
- Generic `script` wake channel.
- Reply sinks: `file`, `webhook` (HMAC-SHA256), `command`, `hufu-report` (report file plus `.DONE` marker).
- Reply delivery (audit repair): after a terminal status (`done`/`failed`/`declined`) a new non-terminal reply is
  refused with exit 1 and nothing is written; an older reply superseded by a terminal one is settled, never retried.
  Re-running the same reply never reports a delivery that is not confirmed (exit 5, `unknown` / `FAILED` shown).
  `recover` re-applies replay-safe sinks (`file`, `hufu-report`) whose outcome is `unknown` (up to `max_attempts`);
  `webhook`/`command` unknowns are still never resent automatically. A delivery that gave up stays `failed` with its
  original reply, hash and revision, and `redeliver` can repair it; `recover` and `redeliver` treat an open attempt as
  live for the same `max(timeout_seconds x 3, 10 min)`.
  A sink result with no `outcome` is a **contract violation**: shown as `report=unknown/contract_violation`, kept with
  its reply, never replayed automatically (also for report sinks); after fixing the sink, repair it by hand with
  `redeliver <id> --after-contract-fix` (`--accept-duplicate-risk` alone does not cover it; a webhook/command also
  needs that flag). `superseded` (exit 0) means an old reply was handled safely and **not delivered**; the newer report
  and the business status are unchanged.
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
- Reliability core (B3/B5 + expiry): business status is separate from sink delivery state; `send`/`ingest` both refuse a new expired id (exit 1, nothing written); recover never auto-resends webhook/command with unknown outcome; `status` prints `report=<delivery>` beside `status=done` so a pending/unknown/conflict report is never masked. Core calls the real `sinkReplaySafe` / `outcome` path (no optional import fallback); a missing `outcome` is a contract violation recorded as `unknown`.
- Lock recovery note: a busy or unreadable per-path lock fails as `not_sent` with a basename-only hint (`<report>.lock`); wake-grokbot never deletes an unknown or live lock automatically.
- Windows: the SIGKILL-based "dead lock holder is reclaimed / live holder is not stolen" case is skipped on win32 (`it.skipIf(process.platform === "win32")`); an alternate Windows verification is still pending.
- State lock (`state.lock`) and sink locks share one primitive (`fsutil.tryLock`/`withLock`, format `wake-lock/1`:
  host, pid, token): never broken by age; reclaimed only when the owner is provably gone (same host, pid no longer
  exists) under a `.reclaim` mutex with a token re-check; this process's own pid always counts as alive. A lock in
  the old `<token> <pid>` format, from another host or unreadable is never removed automatically: `state lock busy`
  (exit 3 as before) with a manual-recovery hint. This is a compatibility change: an old-format lock is no longer cleared for you. Before removing any lock by hand, stop every wake-grokbot process (and scheduled watch) that uses this state dir and confirm the owner host/pid recorded in the lock is gone; never delete a lock whose owner may still be alive, as that allows concurrent writes.
  The reclaim mutex is a directory `<lock>.reclaim/` with one `owner-<token>` file; a dead holder is cleared
  automatically. An owner releases its own lock without the mutex, and a lock this process failed to release is
  removed by this process on its next attempt, so a stale mutex can no longer lock a resident `watch` out.
  Manual procedure: docs/engine-interface.md, "Lock files and manual recovery".
- `task` objects reject unknown keys at runtime (`unknown field: task.<key>`), like the schema.
- Envelope times (`sent_at`, `quoted_at`, `expires_at`) are validated as RFC 3339 at runtime, like the schema.
- The example config no longer ships a `my-hook` webhook (a fresh `init` + `doctor` no longer warns about it).
- Install docs and scheduled-watch examples pin `wake-grokbot@0.1.0` and pass an explicit `--config`; a global install of another version is refused, never used.
- Tests: `install-watch-task.ps1` version-pin checks compare the config path after resolving symlinks, so macOS `/var` and `/private/var` are the same file (Windows short and long temp paths still match).
- Agent skill at `skills/wake-grokbot/SKILL.md`.
- `release`, `prune`, `doctor --dry-run`, JSON log lines, target `description`/`capabilities`, `send --id/--thread`.
- Config discovery order (`--config`, `$WAKE_GROKBOT_CONFIG`, `./wake-grokbot.json`, user folder); errors name the config and the paths searched.
- Windows: variables missing from the process are read from the user, then machine environment (registry); `doctor` shows the source.
- `release` also delivers queued wakes when nothing is in flight and retries a not_started wake without waiting for the backoff.
- Rate limits: HTTP 429, or a 400 that says it is a rate limit, waits for `Retry-After` (capped at 24 hours), otherwise backs off 15, 30, 60 ... minutes, doubling up to 240. Rate limits do not count toward `max_attempts`; a wake is dead only after more than 24 hours of uninterrupted rate limits.
- Claude Code Stop/SubagentStop hook example, BOOTSTRAP.md for agents, A2A state mapping, roadmap.
- Release workflow (npm provenance, tag-triggered), Dependabot, issue/PR templates, code of conduct.
- Optional `expires_at` envelope field. `ingest` checks the id first: a known id follows the idempotency rules (same content: 0, different content: 7); an id removed by `prune` is refused (1); a new id already past `expires_at` is refused (1) and nothing is written. `send` and `ingest` both refuse a new id already past `expires_at` (exit 1, nothing written: no envelope, receipt or queue entry); a known id, including one whose envelope file survived a crash, is checked for idempotency only. An envelope that expires after it was accepted is never woken: right before a wake it leaves the queue with `wake: not_started` and an `expired at …; not woken` detail, and its business status is unchanged (not a failure). `status` and `watch` flag envelopes that expired after they were accepted.
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
