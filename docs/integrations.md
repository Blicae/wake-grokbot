# Integrations

## Claude Code (or any coding agent with a shell)

1. Install: `npm install -g wake-grokbot` or use `npx wake-grokbot`.
2. Copy `skills/wake-grokbot/SKILL.md` into the agent's skills folder (for Claude Code: `.claude/skills/wake-grokbot/SKILL.md`).
3. Run `wake-grokbot init`, then put the wake URL and key in environment variables and run `wake-grokbot doctor`.

The agent then plays one role:

- **Dispatcher**: writes a task envelope, runs `wake-grokbot send --json`, and ends its turn.
- **Worker**: woken by the wake, reads `msg/to-worker/unread`, runs `ack`, does the work, runs `reply`.

## An external engine (for example a Hufu-style task runner)

The engine never needs to know about Grok Bot.

**Handing work in.** Add the engine as a source and let it pipe envelopes in:

```json
{ "sources": { "my-engine": { "require_sig": true } }, "sign": { "key_file": "../keys/sign.key" } }
```

```sh
my-engine export-task T-1 | wake-grokbot ingest --from my-engine -
```

The envelope's `from` must be `my-engine`. With `require_sig`, unsigned or wrongly signed envelopes exit 4.
Exit 6 means "written, wake outcome unknown": the engine must not resend; it can poll `status <id> --json`.

**Getting results back.** The engine picks a sink per task in `reply_to`:

- `{"sink": "hufu-report", "report_path": "/abs/path/reports/T-1.md"}`: a **Hufu-style report file**.
  The first line starts with a status word (进展, 等待, 就绪, 受阻, 失败, 无需处理) followed by the summary.
  For `needs_input` the second line is `待人工决定：<question>`. Then a blank line and the reply body.
  The report is written atomically. Only terminal statuses (`done`, `failed`, `declined`) then create
  `<report>.DONE` (format `wake-report-done/1`, see engine-interface §4); non-terminal replies only update the
  report as a current-progress view. `.DONE` alone is not success: check its `status` (`done` only) and
  `report_sha256`. `report_path` must be absolute and inside one of `sinks.report_roots`; it is never remapped.
- `{"sink": "command", "command_ref": "my-engine"}`: runs the configured command with the reply envelope on stdin.
- `{"sink": "webhook", "url_ref": "my-hook"}`: POSTs the reply. Headers `X-Wake-Grokbot-Timestamp` and
  `X-Wake-Grokbot-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + body)>`. Verify both and reject
  old timestamps. `X-Wake-Grokbot-Delivery-Id: <reply id>` helps a receiver spot repeats; it is not a
  server-side idempotency guarantee. Outcome: 2xx delivered; connection refused or unresolvable before any byte
  was sent: not sent; any other HTTP answer (redirects are never followed, 4xx, 429, 5xx) or a timeout: unknown,
  because the receiver may have acted. Unknown is never resent automatically.
- `{"sink": "file"}`: writes the reply envelope into the reply folder.

The receipt records the sink result. If delivery fails, `reply` exits 5; the reply itself is still in the inbox.

## Scheduled `watch`

`watch` retries queued wakes (backoff, caps, coalescing). Run it every few minutes:

- Windows: [`examples/install-watch-task.ps1`](../examples/install-watch-task.ps1)
- Linux/macOS: [`examples/watch.sh`](../examples/watch.sh) (cron, systemd timer or launchd)
