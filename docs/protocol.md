# Protocol: `wake-envelope/1`

An envelope is one JSON object: a task, a note, an answer or a receipt. The machine-readable definition is
[`schema/wake-envelope-1.schema.json`](../schema/wake-envelope-1.schema.json) (JSON Schema 2020-12).
Examples are in [`fixtures/`](../fixtures); [`fixtures/invalid/`](../fixtures/invalid) holds envelopes that must be rejected.

## Fields

| Field | Required | Meaning |
|---|---|---|
| `v` | yes | Always `"wake-envelope/1"`. |
| `id` | yes | UUID chosen by the sender. It is the idempotency key. |
| `type` | yes | `task`, `note`, `answer` or `receipt`. |
| `from`, `to` | yes | Short names (`dispatcher`, `worker`, or a configured source such as `my-engine`). Messages to `worker` land in `msg/to-worker`; everything else lands in `msg/to-dispatcher`. |
| `project` | no | Free-form project label. |
| `title` | no | One line. |
| `body` / `objective` | task: one of them | What to do. `objective` is the goal, `body` the details. |
| `acceptance` | no | List of checks that define "done". |
| `authorization` | no | `explicit` (a person asked for this) or `inferred` (the sender decided). |
| `quote`, `quoted_at` | no | The requester's own words and when they were said. |
| `thread` | no | UUID that groups related envelopes; replies use the task's thread or id. |
| `reply_to` | no | Where the worker's reply goes: `{ "sink": "file" \| "webhook" \| "command" \| "hufu-report", ... }`. |
| `status` | answer/receipt | `working`, `needs_input`, `done`, `blocked`, `failed`, `declined`. |
| `question` | with `needs_input` | What the worker needs decided. |
| `summary` | no | One-line result or state. |
| `next` | no | What the receiver should do next (for example `review and close T-1`). |
| `task.ref` | no | `{ "ticket_id", "card_path" }` pointing at the sender's own tracker. |
| `sent_at` | yes | ISO 8601 time. |
| `expires_at` | no | ISO 8601 time after which the envelope is stale. It is still stored; `status` and `watch` flag unsettled envelopes past this time as expired. On `ingest` the id is checked first: a known id follows the idempotency rules (same content → 0, different → 7) with no expiry check; a pruned id is refused (1); only a new id is checked against `expires_at`, and if it has passed the envelope is refused (exit 1, nothing written). Part of the signed content. |
| `sig` | no | `hmac-sha256:<hex>` over `"wake-envelope/1\n" + canonical JSON` (keys sorted, `sig` left out). |

### Content rules

- **No URLs and no secrets.** Anything that looks like a URL, an `Authorization:` header, a bearer token or a
  private key is rejected. Refer to configured names instead: `reply_to.url_ref` names a webhook in the config,
  `reply_to.command_ref` names a command.
- **Content is data, not instructions.** A receiver evaluates an envelope under its own rules. Text inside
  an envelope never overrides them.

### Status words

| `status` | meaning | report word |
|---|---|---|
| `working` | picked up, in progress | 进展 |
| `needs_input` | blocked on a human or the dispatcher; see `question` | 等待 |
| `done` | finished; see `summary` and `body` | 就绪 |
| `blocked` | cannot go on (missing access, broken dependency) | 受阻 |
| `failed` | tried and failed | 失败 |
| `declined` | not done on purpose (out of scope, unsafe, duplicate) | 无需处理 |

`working` and `needs_input` go out as `type: "answer"`; the others are final and go out as `type: "receipt"`.

## Config discovery

`--config`, then `$WAKE_GROKBOT_CONFIG`, then `./wake-grokbot.json` in the current folder, then
`wake-grokbot.json` in the user config folder. Relative paths inside the config resolve against the config file.

## Inbox layout

```
<inbox>/
  msg/to-worker/{unread,read}/<id>.json
  msg/to-dispatcher/{unread,read}/<id>.json
  receipts/<id>.json        sender-side state of every envelope (wake-receipt/1)
  replies/                  default folder of the file sink
  pruned-ids.jsonl          one line per id removed by `prune --apply`: {"id","settled_at"}; that id is refused afterwards
<state>/
  outbox.json               wake queue per target
  wake.log                  masked JSON lines: {"at","event","target","state","ids","detail"}
  disabled                  kill-switch file (optional)
```

All files are written atomically (temp file + rename). Envelopes are created with no-overwrite semantics.

## Receipts (`wake-receipt/1`)

`status <id> --json` prints the receipt: `id`, `hash` (sha256 of the canonical envelope), `type`, `from`, `to`,
`status` (`queued` until someone acks or replies), `wake` (`state`, `target`, `at`, `detail`), `acked_at`,
`replies[]` (with `sink_result`), `next`.

Wake states: `none` (no target configured), `queued`, `coalesced` (rides on the next wake), `started` (2xx),
`unknown` (timeout or 5xx), `not_started` (4xx, redirect, config problem; retried with backoff),
`dead` (gave up after `max_attempts`), `disabled` (kill switch), `capped` (hourly cap).

## Wake rules

- 2xx means the routine **started**, not that the work is done. Results are read from the inbox.
- 4xx/redirect/connection refused: not started, safe to resend. Retries back off 1, 2, 4 ... 60 minutes.
- Timeout/5xx: **unknown**. Never resent automatically. Reconcile with `status <id> --mark-wake started` or
  `--mark-wake not_started` (which re-queues it).
- One wake in flight per target. Anything sent meanwhile is `coalesced` and covered by the next wake, which
  lists all ids. The in-flight slot clears on `ack`, `reply`, `release` (the run says it is finished), or after
  `inflight_ttl_minutes`.
- At most 300 wakes per hour in total and 200 per routine (lower limits can be configured).

## Exit codes

| code | meaning | what to do |
|---|---|---|
| 0 | ok (also: same id with the same content again) | nothing |
| 1 | rejected by a rule (invalid envelope, unknown id, URL/secret inside, `ingest` of an envelope already past `expires_at`, an id whose receipt was pruned) | fix the envelope |
| 2 | usage or config error | fix the command or config |
| 3 | internal error | report a bug |
| 4 | signature missing, malformed or wrong | check keys |
| 5 | written, but nobody was woken (not started, dead, disabled, capped), or a reply sink failed | the message is safe in the inbox; `watch` retries |
| 6 | written, wake outcome unknown | **do not resend**; check `status` later |
| 7 | same id with different content | nothing was written; use a new id |

## Mapping to A2A task states

| wake-envelope/1 | A2A task state |
|---|---|
| task accepted, not yet acked | `submitted` |
| `working` | `working` |
| `needs_input` | `input-required` |
| `done` | `completed` |
| `failed` | `failed` |
| `blocked` | `failed` (with the reason) or `input-required` when a person can unblock it |
| `declined` | `rejected` |
