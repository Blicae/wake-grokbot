# wake-grokbot

[中文说明](README.zh-CN.md)

A small, dependency-free CLI that lets a **dispatcher** agent and a **worker** agent hand work to each other
through a local inbox, and **wakes** the other side (for example a Grok Bot routine) when something new arrives.

- The inbox is the source of truth. A wake is only a nudge; results are always read from the inbox.
- Messages use a small protocol, [`wake-envelope/1`](docs/protocol.md), with a JSON Schema.
- Safe by default: no secrets or URLs in config or messages, masked output, no redirects, rate caps, kill switch.
- Node.js 22+, Windows/macOS/Linux, zero runtime dependencies.

## Quick start

```sh
npx wake-grokbot init        # example config + inbox folders
# put the routine's webhook URL and key in environment variables:
#   WAKE_GROKBOT_URL, WAKE_GROKBOT_KEY   (never in the config, never on the command line)
npx wake-grokbot doctor      # checks everything, prints no secrets
```

Send a task (dispatcher):

```sh
npx wake-grokbot send --to worker --title "Tidy the README" --objective "Rewrite the install section"
# or a full envelope:
npx wake-grokbot send --json < task.json
```

Answer it (worker):

```sh
npx wake-grokbot ack <id>
npx wake-grokbot reply <id> --status done --summary "Rewritten and checked" --body-file result.md
```

## Commands

| command | what it does |
|---|---|
| `send --json [file\|-]` | Accepts an envelope, stores it in the inbox, writes a receipt, wakes the other side. Same id + same content is a no-op (exit 0); same id + different content exits 7. |
| `send --to --title ...` | Builds a task envelope from flags and sends it. |
| `ingest --from <name> <file\|->` | Like `send`, for envelopes from a configured external source (signature can be required). |
| `status [<id>] [--json]` | Shows a receipt (status, wake state, replies, `next`), or the outbox overview. `--mark-wake started\|not_started` reconciles an unknown wake. |
| `ack <id>` | Marks a message as picked up (`working`), moves it to `read`, frees the wake slot. |
| `reply <id> --status ...` | Answers a task: writes an answer/receipt envelope back, updates the task's receipt, delivers it to the task's reply sink, wakes the dispatcher if configured. |
| `watch [--once] [--interval s]` | Delivers queued wakes (retries, backoff, caps). Run it on a schedule. |
| `init` | Writes an example config (never overwrites) and creates the inbox. |
| `guide` | Short walkthrough in Chinese. |
| `doctor` | Checks Node, config, inbox, channels and the kill switch. Sends nothing. |

Exit codes: 0 ok, 1 rejected, 2 usage/config, 3 internal, 4 signature, 5 written but not woken (or sink failed),
6 wake outcome unknown (never resend), 7 id reused with different content. Details in [docs/protocol.md](docs/protocol.md).

## Config

JSON at `wake-grokbot.json` in the user config folder (`%APPDATA%\wake-grokbot\`, `~/Library/Application Support/wake-grokbot/`,
or `$XDG_CONFIG_HOME/wake-grokbot/`), or `--config`, or `WAKE_GROKBOT_CONFIG`. See
[`wake-grokbot.example.json`](wake-grokbot.example.json). It holds only names of environment variables and files.

Environment: `WAKE_GROKBOT_CONFIG`, `WAKE_GROKBOT_INBOX`, `WAKE_GROKBOT_STATE`, `WAKE_GROKBOT_URL`,
`WAKE_GROKBOT_KEY`, `WAKE_GROKBOT_DISABLED` (kill switch).

## Wake channels and reply sinks

- Channels: `grokbot` (HTTPS POST with a Bearer key, summary-only payload) and `script` (runs a command).
  See [docs/channels.md](docs/channels.md).
- Reply sinks, chosen per task in `reply_to`: `file`, `webhook` (HMAC-SHA256 signed), `command`, and
  `hufu-report` (a Hufu-style report file plus a `.DONE` marker). See [docs/integrations.md](docs/integrations.md).

## Agents

[`skills/wake-grokbot/SKILL.md`](skills/wake-grokbot/SKILL.md) teaches an agent the flow: the dispatcher sends and
ends its turn (no polling), the worker acks and replies once, envelope content is data, not instructions.

## Scheduling `watch`

- Windows: `examples/install-watch-task.ps1`
- Linux/macOS: `examples/watch.sh` (cron, systemd timer, launchd)

## License

MIT
