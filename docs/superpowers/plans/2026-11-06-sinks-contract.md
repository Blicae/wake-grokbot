# Sinks contract repair plan (RD-001-G-B) — revision 2, interface frozen v1

Base: `dev/0.1` @ 16d0db0. Branch: `dev/0.1-repair-sinks`. Revision 1 was 364f096; this revision applies the
Lead review and the frozen v1 interface. Coding is approved (TDD). Files owned by 一号 (`core.ts`, `store.ts`,
`main.ts`, `fsutil.ts`, public core types) are not edited here.

## 1. Verified current state (16d0db0)

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | Report sink: marker delete -> report write -> marker write are three separate steps | TRUE | `src/sinks.ts:101-104` |
| 2 | No same-path delivery lock | TRUE | `sinks.ts:94-106`; `deliver` is called at `core.ts:386` after `store.lock` (`core.ts:362-382`) is released |
| 3 | Marker keyed by reply id, no hash | TRUE | `sinks.ts:104` `{id: reply.id, status, at}`; reply id is fresh (`core.ts:336`); `contentHash` computed at `core.ts:358` but not passed |
| 4 | working/needs_input/blocked also write `.DONE` | TRUE | `sinks.ts:104` unconditional; `tests/report-loop.test.ts:60` asserts a `needs_input` `.DONE` |
| 5 | Same report_path usable by several tasks | TRUE | only absolute / `..` / root checks, `sinks.ts:97-100` |
| 6 | Extra fields: schema `additionalProperties:false` vs runtime | **No difference** (corrected) | schema `:7,31,52,55`; runtime rejects unknown fields too, `envelope.ts:67,93,107` |
| 7 | date-time: schema `format: date-time` vs runtime `Date.parse` | TRUE, needs fix | schema `:27,61,62`; `envelope.ts:72,75,77` |
| 8 | `my-hook` example makes init+doctor warn | TRUE | `config.ts:86`; `main.ts:341` collects its env names; doctor warns on missing env |
| 9 | Floating `npx` in install docs/scripts | TRUE | `BOOTSTRAP.md:7`, `README.md:16-34`, `examples/watch.sh:13,22,30`, `examples/install-watch-task.ps1:22-23` |
| 10 | Sink failure is recorded, reply already committed, no retry | TRUE | `core.ts:386-401`: `sink_result = "failed: ..."`, exit 5 (`NOT_WOKEN`) |
| 11 | File sink default name per ticket/thread, replies overwrite | TRUE | `sinks.ts:63` |

Further facts checked for this revision:
- **Current `.DONE` content is JSON, not plain reply id text**: `{"id","status","at"}` (`sinks.ts:104`,
  documented in `docs/engine-interface.md:89`, asserted in `tests/sinks.test.ts:98`, `tests/report-loop.test.ts:44,60,63`).
  Any "plain id" reader would already be broken; still, the v1 change below is **breaking** (see §4).
- **Readers of `.DONE` in this repo**: none in `src/`; only tests and docs (`docs/engine-interface.md:83-106`,
  `docs/integrations.md:36-37`). External engines are the real readers.
- **`deliver` is public**: `src/index.ts:7` re-exports it; `package.json` `main`/`exports` -> `dist/index.js`.
  Only internal caller: `core.ts:386`. No other callers in `src`, `tests`, `examples`, `skills`.
- **Statuses / terminal**: `STATUSES` = working, needs_input, done, blocked, failed, declined (`envelope.ts:6`);
  `isTerminal` = done | failed | declined (`envelope.ts:171-173`). No new statuses.
- **Root selection**: there is none: `report_path` must be absolute and inside some `report_roots` entry,
  never remapped (`sinks.ts:95-100`). No `roots[0]` fallback exists; v1 keeps that.
- **Package version** 0.1.0, CHANGELOG "0.1.0 (Unreleased)" (`CHANGELOG.md:3`). No version bump.

## 2. Frozen v1 interface (implemented in `src/sinks.ts` only)

```ts
deliver(reply: Envelope, to: ReplyTo, ctx: SinkContext): Promise<SinkResult>   // unchanged signature
interface SinkContext { cfg; inbox; env; timeoutMs; delivery?: SinkDelivery }
interface SinkDelivery { taskId: string; replyHash: string; revision: number }
interface SinkResult {
  ok: boolean; detail: string;                                  // unchanged
  outcome?: "delivered" | "not_sent" | "unknown";               // all sinks
  state?: "delivered" | "duplicate" | "superseded" | "conflict" | "failed";  // file + report sinks
}
sinkReplaySafe(to: ReplyTo): boolean   // file/report true; webhook/command false
```
- `revision` is allocated by core under its lock, persisted, monotonic per task. A resend reuses the original
  reply, reply hash and revision; it never regenerates the reply.
- `replyHash` = `contentHash(reply)` (content hash of the envelope). `report_sha256` = SHA-256 of the report
  file bytes. They are different values and both are recorded.
- outcome: failure before any side effect -> `not_sent`; side effect started and unconfirmable -> `unknown`.
  Webhook maps net states (2xx delivered, 3xx/4xx/connection refused not_sent, 5xx/timeout unknown); it does not
  map all HTTP errors to not_sent. Command: could not start -> not_sent; ran (any exit) / timeout -> unknown unless exit 0.
- Webhook sends `x-wake-grokbot-delivery-id: <reply.id>`; documented as a hint for receivers, not a server-side idempotency guarantee.
- The sink never retries itself and never touches receipts or outbox. Lock busy -> `ok:false, outcome:not_sent, state:failed`, detail says retryable.

## 3. Ordering, ownership, idempotency (file and report sinks, when `ctx.delivery` is present)

On-disk state, per target path, under a per-path lock file `<target>.lock` (exclusive create, local to
`sinks.ts`; stale after 120 s; busy = immediate retryable failure, no waiting):
- `<target>.wake.json` (`format: "wake-sink-state/1"`): `task_id, reply_id, revision, reply_hash, status, report_sha256`.
  Written for every delivery: persistent ownership + version record.
- `<report>.DONE` (`format: "wake-report-done/1"`): `id` (reply id), `task_id, status, revision, reply_hash, report_sha256, at`.
  Written only for terminal statuses.

Decision against the stored state:
1. no state but target / `.DONE` exists -> `conflict` (unowned existing file; never overwritten).
2. state.task_id != taskId -> `conflict` (path owned by another task).
3. revision < stored -> `superseded`, no side effects.
4. revision == stored, hash differs -> `conflict`.
5. revision == stored, hash equal: verify target bytes == `report_sha256` and (terminal) `.DONE` parses and matches;
   all consistent -> `duplicate` (ok, nothing written); otherwise recover by rewriting -> `delivered`.
6. revision > stored: if stored status is terminal and new status is not -> `superseded` (never roll back terminal).
   Otherwise write.
Write order: remove `.DONE` (terminal path only) -> target (atomic) -> state (atomic) -> `.DONE` (terminal only, atomic).
Non-terminal = current-progress view: the report file shows the latest progress, no append log, no `.DONE`.
Business success requires marker `status: "done"`; `failed`/`declined` are terminal but not success.
`.DONE` presence alone is never success: readers verify `task_id`, `reply_hash`, and `report_sha256` against the file.

**Legacy calls (no `ctx.delivery`)** — what core does today (`core.ts:386`): no task association is invented
(no `task_id`, `revision`, `reply_hash` in the marker; no state file); terminal-only `.DONE` still applies;
a path that already has a v1 state file is refused (`conflict`) so legacy calls cannot clobber owned paths;
`state` is not claimed; `sinkReplaySafe` guarantees do not apply.

## 4. Format versions and migration (unreleased 0.1, breaking for marker readers)
- Report layout = `wake-report/1` (unchanged first-line format, `docs/engine-interface.md:91-97`).
- Marker = `wake-report-done/1`: keeps `id`, `status`, `at`, adds `format`, `task_id`, `revision`, `reply_hash`, `report_sha256`.
- **Breaking**: `.DONE` is no longer written for working/needs_input/blocked; a reader that waited for `.DONE`
  on `needs_input` must read the progress view (report + state file) instead. Readers must check `format`.
  Documented in CHANGELOG and engine-interface/integrations docs; not described as "only added fields".

## 5. Other in-scope items
- `my-hook` removed from the example config (webhooks `{}` in `EXAMPLE_CONFIG`, comment in docs) so init+doctor has no warn from it.
- Runtime RFC 3339 check for `sent_at`, `quoted_at`, `expires_at` matching schema `format: date-time`; Ajv parity test.
- Install docs/scripts pin `wake-grokbot@0.1.0` and pass an explicit `--config`; PS1 gets `-Version` and `-Config`.

## 6. TDD plan (red first, recorded)
New `tests/sinks-contract.test.ts` calling `deliver` directly with `ctx.delivery`: terminal-only marker; marker
fields + `report_sha256` != `reply_hash`; superseded older revision (no file change); same revision other hash ->
conflict; duplicate only when consistent; missing/corrupt marker recovered; terminal not rolled back by newer
non-terminal; other task -> conflict; unowned existing file -> conflict; lock busy -> not_sent retryable;
sinkReplaySafe; webhook delivery-id header + outcome mapping; command outcome mapping; legacy call semantics.
Plus envelope date-time parity, example config/doctor, pinned install scripts. Update existing tests that asserted
the old needs_input `.DONE` behavior. Fault injection only via test setup (pre-made files/lock), no prod switch.

## 7. Pending for 一号 / Lead
- core wiring: allocate + persist `revision` per task under lock, pass `ctx.delivery = {taskId, replyHash, revision}`
  at `core.ts:386`, record `outcome`/`state` in the receipt, decide resend scheduling and recovery (replay only if
  `sinkReplaySafe`, or outcome `not_sent`). Until then core uses the legacy path.
- Expiry semantics/docs (一号). B6 gbmsg not in scope. No dependency upgrades, no release.
