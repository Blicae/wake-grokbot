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
variables (see `wake-grokbot doctor`), never from the config or the envelope. On Windows, use drive-letter
absolute paths (in JSON, backslashes are escaped), for example `"report_roots": ["D:\\Code\\8917\\open-source\\example-reports"]`;
this and every other path in this page is an illustration, not a production location. Relative `report_roots`
and `sign.key_file` values are resolved against the folder of the config file.

Who fills in the real config (source name, `to` mapping, target, `report_roots`, signing) and how a real receiver
is registered: see [engine-consumer.md](engine-consumer.md#7-registration-of-a-real-receiver).

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

- `id` is a fresh UUID per task and is the idempotency key. Re-sending the same envelope never writes a second
  task. Its exit code reports the wake state already recorded for that id: `0` if the earlier wake started (or the
  item is still queued/coalesced, or there is no wake target), `5` if it was `not_started`, `dead`, `disabled` or
  `capped`, `6` if it was `unknown`. One exception wakes again: if the id was accepted, its receipt still says
  `queued`, but the queue entry was lost (crash before the outbox write), the resend puts it back in the queue and
  wakes once. Re-using an id with different content exits 7. (Code: `src/core.ts` `accept`, `codeFor`, `requeueIfLost`.)
- `from` must equal the source name given to `--from`. Signatures are `sig = "hmac-sha256:" + hex(HMAC-SHA256(key,
  "wake-envelope/1\n" + canonical JSON))`; canonical JSON sorts keys recursively and drops `sig` and undefined
  values. The key is a shared secret read from `sign.key_file` (trimmed, at least 16 bytes); there is no public
  key. A signature is required when `sources.<name>.require_sig` or `sign.require` is true. Exit 4: signature
  required but missing, malformed or wrong, or the envelope carries `sig` while no `sign.key_file` is configured.
  An unsigned envelope is accepted when neither switch is set. The public fixture carries no `sig`: whether a
  source must sign is decided when it is registered. Details: [engine-consumer.md](engine-consumer.md#6-signing).
- No URLs and no secrets anywhere in the envelope (exit 1). Refer to configured names instead.
- `report_path` is absolute, has no `..`, lies inside a `report_roots` folder (not the root itself), and is unique
  per task. The fixture's `/srv/reports/build-summary.md` is a Unix example; on Windows use a drive-letter path such as
  `D:\Code\8917\open-source\example-reports\<task-uuid>.md` (JSON: `"D:\\Code\\8917\\open-source\\example-reports\\<task-uuid>.md"`).
  A path outside the roots is refused when the reply is delivered (`reply` exits 5, nothing written), not at `ingest`.
- Optional `expires_at` (RFC 3339 date-time, as `format: date-time` in the schema). `ingest` (and `send`) check the id first: an id it has already accepted follows the
  idempotency rules (same content → 0/5/6 from the recorded wake state, different → 7) with no expiry check, so
  re-sending after expiry is safe.
  A new id that is already past `expires_at` is refused (exit 1, the same class as an invalid envelope; nothing is
  written). If it expires after it was accepted it is not woken (`wake: not_started`, `expired at …`, status
  unchanged), and `status` and `watch` flag the task
  as expired while unsettled.

What happens: the envelope lands in `msg/to-worker/unread/<id>.json`, a receipt in `receipts/<id>.json`, and the
configured target is woken with a short message (ids, type, a one-line summary, the inbox path; never the body).

Exit codes the engine should act on: `0` accepted (and woken, or no wake target), `5` stored but not woken
(`watch` retries), `6` wake outcome unknown — **do not resend**, poll `status <id> --json`. Also: `1` refused by a
rule (invalid or expired envelope), `2` usage or config error, `3` internal error or state lock busy, `4` signature,
`7` id re-used with different content. Full table: [engine-consumer.md](engine-consumer.md#5-exit-codes).

## 3. What the seat does

```sh
wake-grokbot ack <id>                                   # picked up → status working
wake-grokbot reply <id> --status done --summary "build passed" --body-file result.md
```

For an already-authored report, use `reply <id> --status done --keep-report --summary "safe summary"`
without `--body-file` or JSON `body`. The report must exist and not belong to another task. Its body stays
on disk (URLs do not enter the envelope); missing status line/footer is supplied. Use
`redeliver <reply-id> --keep-report` after an unowned-file conflict. `受阻：` + `done --keep-report` is terminal
delivery, not business success; `blocked --keep-report` stays non-terminal. See [consumer rules](engine-consumer.md#3-the-report-wake-report1).

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
   is delivering to that path (stop it first) and that the host/pid recorded in the lock is gone, then delete `<report>.lock` and let core retry the same delivery; On Unix the reclaim path is covered by a SIGKILL child-process test; that case is skipped on Windows and still needs an alternate check.
2. with a task delivery: write the intent `<report>.wake.json` (`wake-sink-state/1`, `phase: "intent"`: owner
   `task_id`, `revision`, `reply_id`, `reply_hash`, `status`, expected `report_sha256`) **before** the report;
3. remove any old `<report>.DONE`, then write `<report>` atomically (non-terminal statuses: this is the
   current-progress view, no append log);
4. with a task delivery: rewrite `<report>.wake.json` with `phase: "committed"`;
5. terminal statuses (`done`, `failed`, `declined`) only: write `<report>.DONE` atomically:
   `{"format":"wake-report-done/1","id":"<reply id>","task_id":"…","revision":N,"status":"<status>","reply_hash":"<sha256 of the reply envelope>","report_sha256":"<sha256 of the report bytes>","at":"<RFC 3339 time>"}`
   (`task_id`, `revision`, `reply_hash` are present only when the caller passed a task delivery).

Ordering with a task delivery: an older revision, or a non-terminal reply after a terminal one, is `superseded`
(nothing written). The same revision with other content or a path owned by another task is always a
`conflict`. An existing unowned file is also a `conflict` unless explicitly adopted with `--keep-report`.
The same revision and content is a `duplicate` only when the report and marker on disk
match (`reply_id`, `status`, actual report bytes vs `report_sha256`, committed phase, and the marker), otherwise
the same delivery repairs its own half-finished writes (any crash window: after intent, report, sidecar or
marker). Files with no `.wake.json` owner are never overwritten without explicit `--keep-report` adoption.
`reply_hash` and `report_sha256` are different values.

**Migration (breaking for earlier development builds).** Before v1 every status wrote `.DONE` as
`{"id","status","at"}`. Now `.DONE` appears only for terminal statuses and carries `format`. A reader that waited
for `.DONE` on `needs_input`/`blocked` must poll the report (or `<report>.wake.json`) instead. Business success means
`status: "done"` and first line `就绪：`; `done` with `受阻：` is terminal delivery, not success;
`failed` and `declined` are final but not success. Verify `report_sha256` against the report.

Report file layout:

```
就绪：build passed            ← line 1: status word + "：" + one-line summary
待人工决定：<question>          ← line 2, only for needs_input
                              ← blank line
<reply body>
```

Status words: `working` 进展, `needs_input` 等待, `done` 就绪, `blocked` 受阻, `failed` 失败, `declined` 无需处理.

**Terminal report footer (receipt information).** A terminal report (`done`, `failed`, `declined`) ends with a
fixed footer after the body and one blank line; `working` / `needs_input` / `blocked` reports have none. The
header (status line, optional decision line, blank line) is unchanged, so line 1 parsing still works. The
footer is part of the report bytes: `report_sha256` in `.DONE` covers it.

```
就绪：build passed
                              ← blank line
<reply body>
                              ← blank line
---
账号用量（周额度，非本单消耗）：已用 62%，剩余 38%，重置：北京时间 2026-11-10 08:00:00
任务执行：开始 北京时间 2026-11-07 10:00:00，完成 北京时间 2026-11-07 11:23:45，耗时 1小时23分45秒
```

- 账号用量: the Grok Bot account's weekly quota as the woken Bot saw it, passed with
  `reply --quota-used/--quota-remaining/--quota-reset` (or `"quota": {used, remaining, reset}` in `reply --json`).
  Missing values read `未提供`; the reply never fails for that. A reset time in zoned ISO-8601 or epoch
  seconds/milliseconds is shown in 北京时间; anything else is shown as given with `（原样，未换算）`. Values
  containing a URL or something secret-like are refused (exit 1, nothing written).
- 任务执行: computed by the CLI. Start = the earliest `ack` or non-terminal (`working` / `needs_input`) reply in
  the task receipt, never the ingest/queue time; finish = the terminal reply's `sent_at`. Without an ack the
  line reads `任务执行：开始时间：未记录领单（ack）时间，完成 北京时间 …，耗时 无法计算`. Duration is Chinese with
  zero units left out (`1小时5秒`, `23分`, `0秒`). All times are Asia/Shanghai, `YYYY-MM-DD HH:MM:SS`.
- The footer is fixed when the reply is first written, so a resend or `redeliver` writes the same bytes.
- It is not part of the envelope: no new envelope field, no change to the reply sent to `webhook`, `command` or
  `file` sinks, no new consume-ack. Engines that ignore it need no change.

The engine waits for `<report>.DONE`, checks `format` and `report_sha256`, then reads the report. A `.DONE` never
points at a half-written report. Final states are `done`, `failed`, `declined`; on `needs_input` or `blocked` the engine may answer with a new envelope
in the same `thread`. The reply envelope also lands in `msg/to-dispatcher/unread/` and the task's receipt records
`sink_result`. If the sink refuses (for example a path outside `report_roots`), `reply` exits 5 and no report or
`.DONE` is written. With a sink, business status stays unchanged until delivery succeeds;
the pending reply remains visible.

Consuming is the engine's own job. There is **no** consume-ack command: the engine watches the report and
`<report>.DONE`, checks `format`, `task_id`, `status` and `report_sha256`, and records what it consumed as
`(task_id, revision, report_sha256, status)` in its own state. HTTP 200, `receipt.done` or a `.DONE` file on its own
is never completion. The `<report>.wake.json` sidecar (`wake-sink-state/1`) is optional to read. The full consumer
rules: [engine-consumer.md](engine-consumer.md).

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

