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
- Optional `expires_at` (ISO 8601): after that time `status` and `watch` flag the task as expired while unsettled.

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

For `reply_to.sink = "hufu-report"`, every reply rewrites the report and its marker, in this order:

1. remove any old `<report>.DONE`;
2. write `<report>` atomically;
3. write `<report>.DONE` atomically: `{"id":"<reply id>","status":"<status>","at":"<ISO time>"}`.

Report file layout:

```
就绪：build passed            ← line 1: status word + "：" + one-line summary
待人工决定：<question>          ← line 2, only for needs_input
                              ← blank line
<reply body>
```

Status words: `working` 进展, `needs_input` 等待, `done` 就绪, `blocked` 受阻, `failed` 失败, `declined` 无需处理.

The engine waits for `<report>.DONE`, then reads the report. A `.DONE` never points at a half-written report.
Final states are `done`, `failed`, `declined`; on `needs_input` or `blocked` the engine may answer with a new envelope
in the same `thread`. The reply envelope also lands in `msg/to-dispatcher/unread/` and the task's receipt records
`sink_result`. If the sink refuses (for example a path outside `report_roots`), `reply` exits 5 and no report or
`.DONE` is written.

This loop is covered by `tests/report-loop.test.ts`, which runs it in a temp folder with the public fixture.
See also [integrations.md](integrations.md) and [threat-model.md](threat-model.md).
