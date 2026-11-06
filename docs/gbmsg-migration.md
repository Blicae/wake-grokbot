# Migrating from gbmsg to wake-grokbot (draft framework)

Status: draft. Only the wake-grokbot side is filled in, from the current CLI and docs
([protocol.md](protocol.md), [engine-interface.md](engine-interface.md)). The gbmsg column is intentionally empty.

## Feature mapping

| Capability | gbmsg | wake-grokbot command | wake-grokbot behaviour |
|---|---|---|---|
| Dispatch a task (派单) | 待指挥官提供功能清单 | `wake-grokbot send --json [file\|-]`, or `send --to worker --title <t> [--objective <o>] [--acceptance <a>]...`; from an external engine: `wake-grokbot ingest --from <source> <file\|->` | Validates a `wake-envelope/1` (no URLs, no secrets, optional signature), stores it in `msg/to-worker/unread/<id>.json` and writes a receipt `receipts/<id>.json`. The `id` is the idempotency key: same id + same content → exit 0, no second wake; same id + different content → exit 7, nothing written. Refused with exit 1, nothing written: a new id whose `expires_at` has already passed (`send` and `ingest`), and an id sent again after `prune --apply` removed its receipt. |
| Queue, coalesce and wake (排队合并叫醒) | 待指挥官提供功能清单 | automatic on `send`/`ingest`; `wake-grokbot watch [--once] [--interval <s>]` delivers queued wakes; `wake-grokbot release [<target>]` frees the slot; `status <id> --mark-wake started\|not_started` reconciles an unknown outcome | One wake in flight per target; anything sent meanwhile is `coalesced` and covered by the next wake, which lists all ids. The slot clears on `ack`, `reply`, `release` or after `inflight_ttl_minutes`. 4xx/redirect/refused → `not_started`, retried with backoff (1, 2, 4 … 60 min) up to `max_attempts`, then `dead`. Timeout/5xx → `unknown` (exit 6), never resent automatically. Hourly caps and a kill switch (`WAKE_GROKBOT_DISABLED` or a `disabled` file) apply. The wake carries ids and a one-line summary only. |
| Receipts (回执) | 待指挥官提供功能清单 | `wake-grokbot status [<id>] [--json]`, `wake-grokbot ack <id>`, `wake-grokbot reply <id> --status <s> [--summary] [--question] [--next] [--body-file]` | Each envelope has a `wake-receipt/1` receipt: `status` (`queued` until acked or replied), `wake` (`state`, `target`, `at`, `detail`), `acked_at`, `replies[]` with `sink_result`, `next`. `reply` writes an answer/receipt envelope back to the dispatcher side and delivers it to the task's `reply_to` sink (`file`, `webhook`, `command`, `hufu-report` = report file + `.DONE`); a failed sink exits 5. |

## Switch-over steps (outline, to be filled in)

1. Prerequisites — _TBD_
2. Config mapping — _TBD_
3. Parallel run / verification — _TBD_
4. Cut-over — _TBD_
5. Post-switch checks — _TBD_

## Rollback steps (outline, to be filled in)

1. Rollback trigger conditions — _TBD_
2. Stop wake-grokbot wakes — _TBD_
3. Restore the previous path — _TBD_
4. Reconcile in-flight messages and receipts — _TBD_
5. Post-rollback checks — _TBD_
