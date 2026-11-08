# Engine consumer guide (wake-grokbot 0.1)

For a task engine (for example a Hufu-style engine) that hands tasks to a worker seat through wake-grokbot and
consumes the reports that come back. It describes only public formats and the public CLI, as implemented in
v0.1.0 (frozen commit `e0c27d07`). Where older notes disagree with the code, this page follows the code.

Scope, agreed for 0.1:

- wake-grokbot provides the same-machine loop (envelope in, wake, report and marker out) and accurate
  documentation. **The integration work is on the engine side**: the engine builds envelopes, waits for reports and
  decides what was consumed. No engine-private code, fields or paths go into wake-grokbot.
- There is **no consume-ack command** and none is planned. The engine watches the report file and `<report>.DONE`,
  verifies the hash, and keeps its own record of what it consumed.
- Closing gaps of the older gbmsg channel is not a precondition for this integration.
- The `<report>.wake.json` sidecar (`wake-sink-state/1`) exists and is **optional** for the engine to read.

**Not completion on their own:** an HTTP 200 from the wake, `receipt.done`, a report file that exists, or a
`.DONE` file that exists. Completion needs all of: the marker belongs to your task, the status is terminal, the
report bytes match `report_sha256`, and your engine recorded the consumption exactly once (section 8).

Deployment assumed here: the engine, the CLI, the inbox and the report folders are on the same machine.

```
engine --ingest--> inbox --wake--> worker seat
                                    | ack, work, reply
engine <-- <report> + <report>.DONE (hufu-report sink, same machine)
engine verifies, consumes, records
```

## 1. Hand in a task: `wake-envelope/1`

Schema: [`schema/wake-envelope-1.schema.json`](../schema/wake-envelope-1.schema.json); protocol:
[protocol.md](protocol.md). Public example: [`fixtures/task-hufu-report.json`](../fixtures/task-hufu-report.json).

```sh
wake-grokbot ingest --from my-engine <envelope.json> --json     # or pipe the envelope on stdin with "-"
```

Windows example envelope (all values are illustrations):

```json
{
  "v": "wake-envelope/1",
  "id": "<task-uuid>",
  "type": "task",
  "from": "my-engine",
  "to": "worker",
  "title": "Summarise the build log",
  "objective": "Read the latest build log and report whether it passed.",
  "authorization": "inferred",
  "reply_to": {
    "sink": "hufu-report",
    "report_path": "C:\\reports\\<task-uuid>.md"
  },
  "task": { "ref": { "ticket_id": "B-7", "card_path": "cards/B-7.md" } },
  "sent_at": "2026-11-05T05:00:00Z"
}
```

Rules:

- `id`: a fresh UUID per task; it is the idempotency key. Remember it: it comes back as `task_id` in the marker.
- `from` must equal the `--from` source name, and that source must exist under `sources` in the config.
- `to` is mapped by the config (`wake.targets`) to the seat that is woken.
- `task.ref` accepts only `ticket_id` and `card_path` (strings). wake-grokbot stores them as references and does
  not interpret them.
- No URLs and no secrets anywhere in the envelope (exit 1). Webhooks and keys are configured by name only.
- `sent_at` is part of the content: a resend must reuse the original envelope (same fields and values),
  otherwise it counts as different content (exit 7).
- Optional `expires_at` (RFC 3339): a new id already past it is refused (exit 1, nothing written).
- Signing: see section 6.

### Report path rules (`reply_to.report_path`)

- Absolute. On Windows use a drive-letter path (`D:\...`); avoid root-relative forms like `\reports\x.md`.
  In JSON, escape backslashes (`"D:\\..."`); forward slashes (`D:/...`) also work on Windows.
- No `..` segment.
- Inside one of the configured `sinks.report_roots` folders, and not the root folder itself.
- **Unique per task.** Do not let two unfinished tasks share a path. A path owned by another task, or an existing
  report, `.DONE` or `.wake.json` without an owner, is a `conflict` by default. Only explicit `--keep-report`
  can adopt an existing report without a sidecar (or owned by this task); another task's report is never overwritten.
- Checked when the seat replies, not at ingest: an out-of-roots path makes `reply` exit 5 and nothing is written.

Example layout (illustration, not a production path):

```
report_roots:  C:\reports
report:        C:\reports\<task-uuid>.md
marker:        C:\reports\<task-uuid>.md.DONE
sidecar:       C:\reports\<task-uuid>.md.wake.json   (optional to read)
lock:          C:\reports\<task-uuid>.md.lock        (do not touch)
```

On Unix the same shape applies, e.g. `/srv/reports/<task-uuid>.md` as in the public fixture.

## 2. Resending the same envelope (idempotency)

Resending an envelope whose `id` is already accepted, with the same content:

- never writes a second task;
- returns the exit code of the wake state already recorded for that id:
  - `0`: the wake started, is still queued or coalesced, or there is no wake target;
  - `5`: the wake was `not_started`, `dead`, `disabled` or `capped`;
  - `6`: the wake outcome is `unknown`;
- one exception wakes again: if the receipt still says `queued` but its queue entry was lost (a crash before the
  outbox write), the resend puts it back in the queue and wakes once; the exit code then follows the new state.

Same `id`, different content: exit 7, nothing written. A known id is not checked for expiry. After a timeout,
**do not** reuse the id with new content; to ask again, send a new envelope (new `id`) in the same `thread`.

## 3. The report: `wake-report/1`

The seat runs `wake-grokbot ack <id>` (status `working`) and later
`wake-grokbot reply <id> --status <status> --summary "<one line>" --body-file <file>`.
For an already-authored report at the agreed path, use
`wake-grokbot reply <id> --status done --keep-report --summary "safe one-line summary"`.
Do not pass `--body-file` or a JSON `body` together with `--keep-report` (usage error). The existing file must
exist and not belong to another task. Its body, including any URLs, stays on disk and never enters the reply
envelope; summary and other envelope fields still undergo URL/credential validation. Missing status lines
and terminal footers are supplied, existing matching titles/footers are preserved, and ownership/marker
checksums cover the final bytes. `redeliver <reply-id> --keep-report` repairs an earlier unowned-file conflict.
Without a sink, reply behavior is unchanged; with a sink, task status changes only after confirmed
delivery. A failed write exits 5 and leaves the old business status plus the pending reply visible in `status`.

The body-file route remains supported: give a body without URLs or a pre-added `就绪：` line, omit
`--keep-report`, and the CLI generates the report. Generated reports use UTF-8, LF line endings:

```
<status word>：<one-line summary>
待人工决定：<question>              (line 2, only for needs_input)

<reply body>
```

The separator after the status word is the full-width colon `：`.

| Status | Status word (line 1) | Writes `.DONE` | Meaning for the engine |
|---|---|---|---|
| `working` | 进展 | no | in progress |
| `needs_input` | 等待 | no | answer with a new envelope (new `id`) in the same `thread` |
| `blocked` | 受阻 | no | not finished, not success |
| `done` | 就绪 (or 受阻 with `--keep-report`) | yes | 就绪 is business success; 受阻 is final delivery, not success |
| `failed` | 失败 | yes | final, not success |
| `declined` | 无需处理 | yes | final, not success |

For non-terminal statuses the report is the current-progress view (overwritten, no append log). Read the report
(or the optional sidecar) to follow progress; do not wait for a `.DONE` that will not come.

An authored `受阻：` first line with `reply --status done --keep-report` is a terminal blocked closure:
preserve that line and write a `done` footer/marker. Consumers must accept it as terminal delivery, **not**
as business success or a request to wait for more work. `done` with `就绪：` remains business success.
Other first-line/status mismatches (e.g. `失败：` with `done`, `受阻：` with `failed`) are refused without
changing the file or committing the new terminal status. `reply --status blocked --keep-report` is still
non-terminal: no footer or `.DONE`.

## 4. The marker: `<report>.DONE` (`wake-report-done/1`)

Written atomically, for terminal statuses only, after the report:

```json
{"format":"wake-report-done/1","id":"<reply id>","task_id":"<task id>","revision":1,"status":"done",
 "reply_hash":"<sha256>","report_sha256":"<sha256>","at":"<RFC 3339 time>"}
```

- `id` is the **reply** id, not the task id. Match on `task_id`.
- `revision` grows per task with each delivered reply generation.
- `report_sha256` = SHA-256 (hex) of the report file's bytes.
- `reply_hash` = SHA-256 of the canonical reply envelope (keys sorted, `sig` dropped). It is a different value from
  `report_sha256`; use it for audit only.

Write order: lock, sidecar `phase: "intent"`, remove old `.DONE`, write report, sidecar `phase: "committed"`,
then `.DONE` (terminal only). So a completed write never leaves a `.DONE` pointing at a half-written report.

Read order: see `.DONE` → check `format`, `task_id`, `status` → hash the report bytes and compare with
`report_sha256` → read the report text. If the hash does not match, a higher revision may be rewriting the files
(it removes the old `.DONE` first): wait and re-read marker and report together; do not fail on one snapshot.

**Old markers:** development builds before v1 wrote `{"id","status","at"}` without `format`, for every status. A
marker without `format: "wake-report-done/1"` is not a success under this contract.

### Optional sidecar: `<report>.wake.json` (`wake-sink-state/1`)

`{"format":"wake-sink-state/1","task_id":…,"revision":…,"reply_hash":…,"reply_id":…,"status":…,"report_sha256":…,"phase":"intent"|"committed"}`.
Reading it is optional; it helps to see non-terminal progress or a write in flight. It never replaces the
`.DONE` checks. Never edit or delete it.

## 5. Exit codes

| Code | Meaning | What the engine does |
|---|---|---|
| 0 | accepted (woken, wake queued/coalesced, or no wake target) | wait for the report |
| 1 | refused by a rule: invalid or expired new envelope, URL/secret in it, `from` ≠ `--from`, id pruned; for `reply`, a non-terminal reply after a terminal one | fix the cause; do not resend unchanged |
| 2 | usage or config error (also unknown source, unreadable or too short `sign.key_file`) | fix the command or have the config fixed |
| 3 | internal error or state lock busy/timeout | lock busy: retry the same command later; otherwise stop and read the error |
| 4 | signature: required but missing, malformed or wrong; or `sig` present with no key configured | fix signing; do not change the id |
| 5 | stored, not woken (`not_started`/`dead`/`disabled`/`capped`, incl. expired before the wake); for `reply`/`redeliver`, the report was not delivered (e.g. path outside `report_roots`) | `watch` retries wakes while not expired; an undelivered report is not success |
| 6 | wake outcome unknown | **do not resend**; poll `status <id> --json` |
| 7 | id re-used with different content | stop; check id generation |

While waiting: `wake-grokbot status <id> --json` shows the task status, the wake state and the last report delivery
(`sink_result`) before you read the disk. There is no `recover` command; `watch` repairs half-finished report
writes, and `redeliver <reply-id>` is a manual tool for the seat's operator.

## 6. Signing

- Algorithm: `sig = "hmac-sha256:" + hex(HMAC-SHA256(key, "wake-envelope/1\n" + canonical(envelope)))`.
  `canonical` = JSON with keys sorted recursively, `sig` removed, undefined values removed (`src/envelope.ts`).
- Key: a **shared secret** in the file named by `sign.key_file` (UTF-8, trimmed, at least 16 bytes). It is HMAC,
  so there is **no public key**; the engine needs the same secret, handed over out of band by whoever registers the
  source. Never put the key or its path in an envelope, a chat or a log.
- When required: `sources.<name>.require_sig: true` (per source, for `ingest`) or `sign.require: true` (all).
- Exit 4 when: signing is required and `sig` is missing; `sig` is malformed or wrong; or the envelope has `sig` but
  no `sign.key_file` is configured. If signing is not required and there is no `sig`, the envelope is accepted.
- The public fixture has no `sig`. **Whether your source must sign is decided at registration.**
- A signed envelope must be resent with the same `sig`; the signature is not part of the content hash.

## 7. Registration of a real receiver

A real receiver (the seat that is woken, its wake routine, the config and the report folders) is registered by the
operators who own the machine's wake and inbox configuration (the matrix or the commander), not by developers and
not by the engine. Developers do not change that config, do not handle keys, and do not print webhook URLs, keys or
tokens. Registration records only names, paths and "set / not set":

- machine, seat, wake routine name and whether it is enabled (not a test routine);
- CLI install location, `wake-grokbot --version`, and the deployed version/commit (v0.1.0 / `e0c27d07` or later);
- config file path, `inbox`, `state_dir`, `sinks.report_roots`;
- source name under `sources` (the engine's `--from`) and its `require_sig`;
- `wake.targets` mapping for `to` (e.g. `worker` → target), the target's `channel` and `routine`;
- the webhook URL config item and key: only the **names** of the environment variables (`url_env`, `key_env`) and
  whether they are set — never the values;
- `sign.key_file` / `sign.require` if signing is used (path recorded by the operator, content never copied);
- the rule that makes each task's report path absolute, unique and inside `report_roots`;
- isolation: the inbox and report folders are not those of any other production channel.

Acceptance, with non-sensitive evidence only: `wake-grokbot doctor` passes; the folders exist; the seat can read
the inbox, `ack`, `reply`; a reply writes the report and, for a terminal status, a `.DONE` whose `format`,
`task_id` and `report_sha256` check out. Until the operators confirm it, treat the receiver as **not registered**.

## 8. Consuming and recording (engine side)

A terminal report can be signed for only if the existing format, task, terminal-status and byte checks hold.
For `done`, accept either `就绪：` (business success) or `受阻：` (final delivery, not business success).
Keep your consumption record in both cases; never wait for continuation of a signed-for blocked closure.

A report counts as business success only if all hold:

1. `.DONE.format == "wake-report-done/1"`
2. `.DONE.task_id` equals the envelope `id` you sent
3. `.DONE.status == "done"` (`failed`/`declined` are final outcomes to handle, never success)
4. SHA-256 of the report bytes equals `.DONE.report_sha256` (on mismatch, re-read later; see section 4)
5. line 1 of the report starts with `就绪：`
6. your engine records the consumption and it is not a repeat

Keep a durable record of consumed tuples `(task_id, revision, report_sha256, status)`:

- same tuple seen again: already consumed, **do not** run the business step again;
- same `revision` but different hash or status: conflict; stop and hand to a person; do not overwrite;
- higher `revision`: wake-grokbot may write a later terminal result after an earlier one (e.g. `done`, then
  `failed`), removing the old `.DONE` first. Consume it only if your business allows replacing the earlier result.
  Never assume a consumed `done` stays the same forever; never apply an older revision;
- checks still failing after re-reads: do not mark consumed, and never report it as success.

wake-grokbot's own delivery outcomes (`delivered`, `duplicate`, `superseded`, `conflict`) appear in `status --json`
for diagnosis; they are not a consumption record.

## 9. Do not

- treat HTTP 200, `receipt.done`, a report file alone or a `.DONE` alone as completion;
- resend an id with new content, or resend after exit 6;
- delete `.lock`, `.wake.json` or `.DONE` files (lock recovery is an operator procedure: [engine-interface.md](engine-interface.md#lock-files-and-manual-recovery));
- rely on private formats of any engine or channel inside wake-grokbot.

See also: [engine-interface.md](engine-interface.md), [protocol.md](protocol.md), [threat-model.md](threat-model.md).
Report root examples: `C:\reports` on Windows; `/srv/reports` on Linux/macOS. Use an absolute path available to the consumer.
