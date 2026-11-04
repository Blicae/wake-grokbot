# Wake channels

A wake target in the config picks a channel. Two ship with 0.1.0.

## `grokbot`

POSTs to a Grok Bot routine webhook.

- URL: from the environment variable named by `url_env` (default `WAKE_GROKBOT_URL`) or the first line of `url_file`.
  `https` is required except for loopback. The URL is never printed.
- Key: `--key-stdin`, then the variable named by `key_env` (default `WAKE_GROKBOT_KEY`), then `key_file`.
  Sent as `Authorization: Bearer <key>`.
- Body: `{ "<payload_key>": "<text>", "wake": { "id", "type", "summary", "inbox_path", "ids", "count" } }`.
  `payload_key` defaults to `text`. `template` may use `{id} {type} {summary} {inbox_path} {count} {ids}`.
- `routine` names the routine for the per-routine hourly cap; `per_routine_hourly_cap` lowers it (max 200).

The exact payload a Grok Bot routine expects may differ per setup; adjust `payload_key` and `template`.

## `script`

Runs `argv` (no shell) with the wake summary as JSON on stdin. Exit 0 means started, a timeout means unknown,
any other exit means not started. Use it for anything else: a chat bot, a desktop notification, another agent runner.

## Adding a channel

```ts
import { registerChannel } from "wake-grokbot";
registerChannel("my-channel", (name, cfg) => ({
  check(ctx) { /* throw if misconfigured; never print secrets */ },
  describe: () => `my-channel ${name}`,
  async wake(payload, ctx) { return { state: "started", detail: "ok" }; },
}));
```
