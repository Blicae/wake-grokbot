# Engine interface (one page)

How a task engine hands a task to a worker seat, gets that seat woken, and learns that the work is finished.
Everything here uses the public `wake-envelope/1` format ([protocol.md](protocol.md),
[schema](../schema/wake-envelope-1.schema.json)) and the public fixture
[`fixtures/task-hufu-report.json`](../fixtures/task-hufu-report.json). The engine never talks to the woken service directly.

```
engine ──ingest──▶ inbox/msg/to-worker ──wake──▶ worker seat
                                                   │ ack, work, reply
engine ◀── <report>.md + <report>.md.DONE ◀────────┘ (hufu-report sink)
```

## 1. One-time config (names only, no secrets)

```json
{
  "sources": { "my-engine": { "require_sig": true } },
  "sign": { "key_file": "../keys/sign.key" },
  "sinks": { "report_roots": ["/abs/reports"] },
  "wake": { "targets": { "worker": "grokbot" } }
}
```

`report_roots` lists the only folders reports may be written to. The wake URL and key come from environment
variables (see `wake-grokbot doctor`), never from the config or the envelope.

## 2. Waking a seat: hand in a task

The engine writes one envelope and pipes it in:

```sh
my-engine export-task B-7 | wake-grokbot ingest --from my-engine - --json
```

The public example (`fixtures/task-hufu-report.json`):

```json
{
  "v": "wake-envelope/1",
  "id": "55555555-5555-4555-8555-555555555555",
  "type": "task",
  "from": "my-engine",
  "to": "worker",
  "title": "Summarise the build log",
  "objective": "Read the latest build log and report whether it passed.",
  "authorization": "inferred",
  "reply_to": { "sink": "hufu-report", "report_path": "/srv/reports/build-summary.md" },
  "task": { "ref": { "ticket_id": "B-7", "card_path": "cards/B-7.md" } },
  "sent_at": "2026-11-05T05:00:00Z"
}
```

Rules the engine must follow:

- `id` is a fresh UUID per task and is the idempotency key. Re-sending the same envelope is safe (exit 0, no second wake);
  re-using an id with different content exits 7.
- `from` must equal the source name given to `--from`. With `require_sig`, add `sig` (`hmac-sha256` over
  `"wake-envelope/1\n"` + canonical JSON); missing or wrong signatures exit 4.
- No URLs and no secrets anywhere in the envelope (exit 1). Refer to configured names instead.
- `report_path` is absolute, has no `..`, and lies inside a `report_roots` folder.
- Optional `expires_at` (RFC 3339 date-time, as `format: date-time` in the schema). `ingest` checks the id first: an id it has already accepted follows the
  idempotency rules (same content → 0, different → 7) with no expiry check, so re-sending after expiry is safe.
  A new id that is already past `expires_at` is refused (exit 1, the same class as an invalid envelope; nothing is
  written). If it expires after it was accepted, `status` and `watch` flag the task
  as expired while unsettled.

What happens: the envelope lands in `msg/to-worker/unread/<id>.json`, a receipt in `receipts/<id>.json`, and the
configured target is woken with a short message (ids, type, a one-line summary, the inbox path; never the body).

Exit codes the engine should act on: `0` accepted (and woken, or no wake target), `5` stored but not woken
(`watch` retries), `6` wake outcome unknown — **do not resend**, poll `status <id> --json`.

## 3. What the seat does

```sh
wake-grokbot ack <id>                                   # picked up → status working
wake-grokbot reply <id> --status done --summary "build passed" --body-file result.md
```

Statuses: `working`, `needs_input` (needs `--question`), `done`, `blocked`, `failed`, `declined`.

## 4. Reporting completion: report file + `.DONE`

For `reply_to.sink = "hufu-report"` (report layout `wake-report/1`, marker format `wake-report-done/1`):

1. take a per-path lock `<report>.lock` (records host, pid, process start time and a random token). A busy lock
   fails the delivery with outcome `not_sent` (retryable). A lock is never taken over because of its age: it is
   reclaimed only when its owner is provably gone (same host, pid no longer exists), and only while holding the
   reclaim mutex `<report>.lock.reclaim/` (a directory with one `owner-<token>` file), re-checking the owner token
   first. A live lock is never moved or removed. A reclaim mutex whose holder is provably dead is cleared
   automatically (only that holder's own file is removed). See "Lock files and manual recovery" below. A lock from another host, an
   unreadable lock, or a live (or possibly reused) pid stays; **manual recovery**: make sure no wake-grokbot process
   is delivering to that path, delete `<report>.lock`, and let core retry the same delivery;
2. with a task delivery: write the intent `<report>.wake.json` (`wake-sink-state/1`, `phase: "intent"`: owner
   `task_id`, `revision`, `reply_id`, `reply_hash`, `status`, expected `report_sha256`) **before** the report;
3. remove any old `<report>.DONE`, then write `<report>` atomically (non-terminal statuses: this is the
   current-progress view, no append log);
4. with a task delivery: rewrite `<report>.wake.json` with `phase: "committed"`;
5. terminal statuses (`done`, `failed`, `declined`) only: write `<report>.DONE` atomically:
   `{"format":"wake-report-done/1","id":"<reply id>","task_id":"…","revision":N,"status":"<status>","reply_hash":"<sha256 of the reply envelope>","report_sha256":"<sha256 of the report bytes>","at":"<RFC 3339 time>"}`
   (`task_id`, `revision`, `reply_hash` are present only when the caller passed a task delivery).

Ordering with a task delivery: an older revision, or a non-terminal reply after a terminal one, is `superseded`
(nothing written); the same revision with other content, a path owned by another task, or an existing unowned
file is a `conflict`; the same revision and content is a `duplicate` only when the report and marker on disk
match (`reply_id`, `status`, actual report bytes vs `report_sha256`, committed phase, and the marker), otherwise
the same delivery repairs its own half-finished writes (any crash window: after intent, report, sidecar or
marker). Files with no `.wake.json` owner are never overwritten. `reply_hash` and `report_sha256` are different values.

**Migration (breaking for earlier development builds).** Before v1 every status wrote `.DONE` as
`{"id","status","at"}`. Now `.DONE` appears only for terminal statuses and carries `format`. A reader that waited
for `.DONE` on `needs_input`/`blocked` must poll the report (or `<report>.wake.json`) instead. Success means
`status: "done"`; `failed` and `declined` are final but not success. Verify `report_sha256` against the report.

Report file layout:

```
就绪：build passed            ← line 1: status word + "：" + one-line summary
待人工决定：<question>          ← line 2, only for needs_input
                              ← blank line
<reply body>
```

Status words: `working` 进展, `needs_input` 等待, `done` 就绪, `blocked` 受阻, `failed` 失败, `declined` 无需处理.

The engine waits for `<report>.DONE`, checks `format` and `report_sha256`, then reads the report. A `.DONE` never
points at a half-written report. Final states are `done`, `failed`, `declined`; on `needs_input` or `blocked` the engine may answer with a new envelope
in the same `thread`. The reply envelope also lands in `msg/to-dispatcher/unread/` and the task's receipt records
`sink_result`. If the sink refuses (for example a path outside `report_roots`), `reply` exits 5 and no report or
`.DONE` is written.

This loop is covered by `tests/report-loop.test.ts`, which runs it in a temp folder with the public fixture.
See also [integrations.md](integrations.md) and [threat-model.md](threat-model.md).

## Lock files and manual recovery

wake-grokbot uses lock files next to the data they protect: `<state>/state.lock` (inbox state) and
`<report>.lock` (report and file sinks), each with a reclaim mutex `<lock>.reclaim/`. Lock files contain
`{"format":"wake-lock/1","host":…,"pid":…,"token":…}`; the mutex directory holds one `owner-<token>` file with
the same identity.

Automatic handling: a lock or mutex is removed only by its owner, or when its owner is provably gone (same host
and the pid no longer exists). Never because of its age. A process releases its own lock without the mutex, so a
stale mutex can never make a long-running process (for example `watch --interval`) lock itself out.

Cases that need a person (the command fails with `state lock busy` (exit 3) or the sink with `not_sent`, both
retryable, and the message names the file):
- a lock or mutex from another host (shared or network folder), or one whose pid is alive (or reused);
- an unreadable lock, or one in the old `<token> <pid>` format of earlier development builds (never removed
  automatically: conservative compatibility);
- a mutex directory with unexpected content.

Procedure (before an upgrade, and whenever such a message appears):
1. Stop every wake-grokbot process that uses this inbox or report folder (scheduled `watch`, engines, hooks).
2. Read the file: check `host` and `pid`. On that host, confirm no process with that pid is a wake-grokbot/node
   process for this inbox. If it is alive, do not delete anything: wait for it or stop it first.
3. Only then delete `state.lock` / `<report>.lock` and the `.reclaim` directory next to it. Never delete a lock
   whose owner you cannot identify while any related process may still run.
4. Start the processes again; core retries the delivery.

Windows: pid liveness uses the same check; equivalence of process termination on Windows is pending platform
validation.

