# Sinks contract repair plan (RD-001-G-B, plan only)

Base: `dev/0.1` @ 16d0db0. Branch: `dev/0.1-repair-sinks`. No code changes in this commit.

## 1. Current state (verified at 16d0db0)

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | Report sink does marker delete -> report write -> marker write as three separate steps (not one atomic unit) | TRUE | `src/sinks.ts:101-104` (`rmSync(done)`, `atomicWrite(target)`, `atomicWrite(done)`) |
| 2 | No same-path delivery lock around the report sink | TRUE | `src/sinks.ts:94-106` has no lock; `deliver()` is called in `src/core.ts:386` *after* `store.lock` (`core.ts:362-382`) is released; `withLock` exists only in `src/fsutil.ts:81` and is used by store |
| 3 | Marker is keyed by reply id, not task id, and has no content hash | TRUE | `src/sinks.ts:104` writes `{id: reply.id, status, at}`; reply id is a fresh UUID (`core.ts:336`); `contentHash` exists (`envelope.ts:136`) and is computed in `core.ts:358` but not passed to sinks |
| 4 | Non-terminal statuses (working / needs_input / blocked) also write `.DONE` | TRUE | `sinks.ts:104` is unconditional; `isTerminal` (`envelope.ts:171-173`) only covers done/failed/declined and is not used in sinks |
| 5 | Report path is caller-chosen and can be shared by several tasks | TRUE | `report_path` comes from the original task's `reply_to` (`core.ts:386`); only root/absolute/`..` checks (`sinks.ts:97-100`), no uniqueness |
| 6 | Schema `additionalProperties:false` mirrored at runtime | TRUE | schema `:7,31,52,55`; runtime `envelope.ts:67,93,107` |
| 7 | `date-time` format is stricter in schema than at runtime | TRUE | schema `:27,61,62` `format: date-time`; runtime uses `Date.parse` (`envelope.ts:72,75,77`) which accepts e.g. `2026-11-06` or locale strings |
| 8 | `my-hook` example webhook makes a fresh `init` user get a doctor `warn` | TRUE | example config `config.ts:86`; doctor collects webhook env names `main.ts:341` and warns on missing env (`main.ts:373`) |
| 9 | Install docs/scripts use floating `npx` (no pinned version) | TRUE | `BOOTSTRAP.md:7`, `README.md:16-34`, `examples/watch.sh:13,22,30`, `examples/install-watch-task.ps1:22-23` (`--yes wake-grokbot`, no `@0.1.0`) |
| 10 | Sink failure is recorded but reply is already committed | TRUE | `core.ts:386-401`: result stored as `sink_result`, exit `NOT_WOKEN`; no retry path for the sink |
| 11 | File sink falls back to ticket/thread name, so replies to one task overwrite each other | TRUE | `sinks.ts:63` |

Contract boundary: core calls exactly one function, `deliver(reply, orig.reply_to, ctx)` (`core.ts:12,386`), and reads `{ok, detail}`.

## 2. Proposed sinks <-> core interface

```ts
interface SinkDelivery {
  taskId: string;        // original task envelope id (association key)
  reply: Envelope;
  replyHash: string;     // contentHash(reply), computed by core
  to: ReplyTo;
}
interface SinkResult { ok: boolean; detail: string; state: "delivered" | "duplicate" | "conflict" | "failed"; }
deliver(d: SinkDelivery, ctx: SinkContext): Promise<SinkResult>
```

Rules:
1. **Association**: every report/marker carries `task_id` + `reply_id` + `reply_hash` + `status`.
2. **Status semantics**: only terminal statuses (`isTerminal`: done/failed/declined) write `.DONE`. Non-terminal statuses update the report only and remove nothing they did not write.
3. **`.DONE` is never success by itself**: readers must check marker `task_id` and `reply_hash` against the report content (report header line carries the hash). Mismatch = `conflict`, not done. `status` in the marker decides success; `failed`/`declined` markers are terminal but not success.
4. **Unique report path**: default derived path `<root>/<task_id>.report.md`; a caller `report_path` already bound to a different `task_id` (per its marker/sidecar) is rejected with `conflict`.
5. **Concurrency**: per-path lock (`withLock("<report>.lock")`) around read-check-write. Inside the lock: same `task_id` + same hash -> `duplicate` (idempotent, ok=true, no rewrite); same task, new hash -> rewrite report, then marker; other task -> `conflict`. Marker write stays last; consistency check after write.
6. **Compatibility**: `deliver(reply, to, ctx)` is a public export (`src/index.ts`). Keep an overload/adapter for one minor version, mark deprecated; marker JSON gains fields (additive). Envelope format `wake-envelope/1` unchanged. CHANGELOG entry + note in `docs/protocol.md` / `docs/engine-interface.md`. Bump to 0.2.0 if the overload is dropped.

## 3. Coordination with 一号 (owner of core.ts / store.ts / main.ts / fsutil.ts / shared types)
- core must pass `taskId` (= `id`) and the already computed `hash` (`core.ts:358`) into `deliver`; core must map `state` into `sink_result`.
- Dedupe rule must match their persistence/resend contract: same reply id + same hash = duplicate, different hash = conflict (mirrors `core.ts:365`). Need agreement that a sink re-delivery on resend uses the stored reply (same hash).
- Whether sink lock reuses `fsutil.withLock` as-is (timeouts/stale-break values) or needs a variant.
- Expiry (`expires_at`) semantics belong to 一号; sinks do not inspect expiry.
- Whether `SinkResult.state` lives in shared types.

## 4. my-hook / schema / install pin
- Example config: drop or comment out the `my-hook` webhook (or have doctor say `info` for example-only names) so a fresh user gets no default warn; test via doctor output snapshot.
- Schema vs runtime: add an RFC 3339 check at runtime for `sent_at`, `quoted_at`, `expires_at` (or relax schema text); add a parity test feeding the same fixtures to Ajv (+formats) and `validate()`.
- Install pin: docs and scripts use `wake-grokbot@<version>` (`npx --yes wake-grokbot@0.1.x`), the PS1 script takes a `-Version` parameter; examples test asserts no unpinned `npx wake-grokbot` in shipped scripts.

## 5. TDD plan (write failing tests first, in `tests/sinks.test.ts` unless noted)
1. `working`/`needs_input`/`blocked` reply -> no `.DONE`; `done` -> `.DONE` with task_id + hash.
2. `.DONE` present but report hash mismatch -> reader reports conflict.
3. Two tasks targeting one report_path -> second gets `conflict`, first report intact.
4. Same reply delivered twice -> `duplicate`, file mtime unchanged.
5. Parallel deliveries on one path (child processes) -> one consistent report+marker pair.
6. Crash between report and marker (inject) -> no marker, rerun completes.
7. Legacy `deliver(reply, to, ctx)` signature still works (compat).
8. `tests/envelope.test.ts`: schema/runtime parity on bad date-times.
9. `tests/examples.test.ts`: fresh init + doctor has no `my-hook` warn; scripts pinned.

## 6. Out of scope
B6 gbmsg work, dependency upgrades, release/publish, changes to files owned by 一号 (only requested via section 3).

## 7. Open questions
- Keep the current report sink enum name or add a neutral alias (`report`) with a migration note?
- Should non-terminal statuses keep overwriting the same report, or append?
- Is dropping the legacy `deliver` signature in 0.2.0 acceptable?
