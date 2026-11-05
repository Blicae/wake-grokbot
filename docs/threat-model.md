# Threat model

Scope: wake-grokbot 0.1 — the CLI, the local inbox, the wake channels and the reply sinks.
Format: for each threat, what the attacker wants, what wake-grokbot does today, and what is left to the operator.
See also [SECURITY.md](../SECURITY.md) (reporting) and [protocol.md](protocol.md) (the envelope format).

## Assets and trust boundaries

| Asset | Where it lives |
|---|---|
| Wake URL and wake key | environment variables, a `url_file` / `key_file`, or `--key-stdin` |
| Signing key (`sign.key_file`) | a file outside the repository |
| Webhook sink URL and signing secret | environment variables named in the config |
| Envelopes, receipts, replies | the inbox folder (local disk) |
| Report files written by the `hufu-report` sink | under `sinks.report_roots` |

Trust boundaries: (1) the local user account that runs the CLI — fully trusted; (2) other local processes that can
write into the inbox — trusted only as far as file permissions allow; (3) external sources that call `ingest` —
untrusted unless their envelopes are signed; (4) the remote wake endpoint and webhook receivers — reachable over
the network; (5) the agent that reads the inbox — must treat everything in an envelope as data.

Out of scope: a compromised local account, a compromised Node.js runtime, and the security of the remote
service that is woken.

## 1. Key flow (secret leakage)

Threat: a wake key, URL or webhook secret ends up in a config file, a command line, a log, an envelope or an error
message, and from there in a repository, a chat or a screenshot.

Mitigations in place:
- The config holds names only. Keys named `url`, `token`, `key`, `secret`, `password` or `authorization`, and any
  URL value, are refused when the config is loaded.
- Keys are read from an environment variable, a file, or `--key-stdin`; never from argv (which other processes can
  read). `--key-stdin` cannot be combined with reading the envelope from stdin.
- Every known secret is registered and masked (`***`) in stdout, stderr and `wake.log`; bearer tokens,
  token-looking strings and every URL are masked by pattern as well.
- Envelopes containing a URL or something that looks like a credential are rejected (exit 1).
- A wake carries ids and a one-line summary only, never result bodies.
- `doctor` reports where a variable was found, never its value; `doctor --dry-run` hides URL and key.
- Wake and webhook requests refuse redirects, so a key is never forwarded to another host; plain `http` is
  allowed to loopback only.

Left to the operator: file permissions on `key_file` / `sign.key_file`; keeping those files outside any repository;
rotating a key that was exposed.

## 2. Replay

Threat: someone re-submits an old envelope (copied from disk or captured from a sink) so the worker acts on it again,
or so it is woken repeatedly.

Mitigations in place:
- The `id` is the idempotency key. The same id with the same content is accepted once and then returns the
  existing receipt (exit 0, no second wake); the same id with different content is refused (exit 7, nothing written).
- `sent_at` is part of the hashed and signed content, so a replay cannot freshen it without breaking the signature.
- **`expires_at` (optional).** A sender can bound how long an envelope is meaningful. After that time `status` and
  `watch` flag the envelope as expired while it is still unsettled. `expires_at` is covered by the signature.
  It is advisory: the envelope is still stored and nothing is deleted or rejected automatically, so a worker
  should check it before acting.
- Wakes are rate-limited (hard caps per hour, one wake in flight per target) and can be stopped with the kill switch.
- Outgoing webhook replies carry `x-wake-grokbot-timestamp`, and the timestamp is part of the HMAC, so a receiver
  can reject old deliveries.

Gaps: receipts can be pruned (`prune --apply`); an id replayed after its receipt was pruned is accepted as new.
There is no built-in rejection window on `sent_at`; use `expires_at` plus signatures for sources that matter.

## 3. Forged replies and forged envelopes

Threat: a third party writes a fake `done` receipt or a fake task into the inbox, or posts one through `ingest`,
pretending to be the dispatcher, the worker, or an engine.

Mitigations in place:
- **Signatures.** With `sign.key_file` set, outgoing envelopes are signed: `hmac-sha256` over
  `"wake-envelope/1\n" + canonical JSON`. `sign.require: true` refuses unsigned envelopes; any wrong or malformed
  signature is refused (exit 4). Comparison is constant-time. Keys shorter than 16 bytes are refused.
- **Sources.** `ingest --from <name>` only accepts configured sources, the envelope's `from` must equal that name,
  and `require_sig` per source forces a signature.
- **Webhook sink.** Replies sent to a webhook carry `x-wake-grokbot-signature: sha256=<hmac>` over
  `<timestamp>.<body>`; receivers should verify it.

Gaps: without a signing key, anything that can write to the inbox folder can forge a message — protect the folder
with file permissions or turn signing on. The HMAC key is shared, so it proves "someone holding the key", not which
side wrote the envelope.

## 4. Path traversal

Threat: an envelope names a file path that makes a sink write outside its folder (overwrite a config, a shell
profile, a report somewhere else).

Mitigations in place:
- `reply_to.file` must be a plain file name (`[A-Za-z0-9._-]`, no leading dot); it is written inside the reply folder.
- `reply_to.report_path` (`hufu-report` sink) must be absolute, must not contain `..`, and must resolve —
  after following symlinks of every existing parent — inside one of `sinks.report_roots`. With no roots
  configured the sink refuses to write.
- Envelope files are named by their validated UUID; inbox paths are never taken from envelope text.
- `url_ref` and `command_ref` must be short config names; the envelope can only choose among commands and webhooks
  the operator configured, never supply its own.

Left to the operator: keep `report_roots` narrow; do not point them at folders other users can write to.

## 5. Envelope injection (prompt injection through content)

Threat: text inside `title`, `body`, `objective`, `summary` or `question` tries to steer the agent that reads it
("ignore your rules and …"), or tries to smuggle a URL or credential through the wake.

Mitigations in place:
- The protocol states that envelope content is data, never instructions; the bundled skill tells agents to evaluate
  it under their own rules.
- URLs and secret-looking strings are rejected anywhere in the envelope, so an envelope cannot carry a link to fetch
  or a credential to use.
- Unknown fields are rejected (`additionalProperties: false`), so no side channel exists in extra keys.
- The wake itself carries only ids and a one-line summary; the agent reads the full envelope from the inbox.
- `authorization: "inferred"` marks work the sender decided on its own, so the worker can apply stricter rules.

Gaps: content rules are pattern-based and cannot catch every phrasing; the last line of defence is the reading
agent's own policy.

## Summary

| Threat | Main control | Exit code |
|---|---|---|
| Key leakage | names-only config, stdin/env keys, masking | 1 (envelope), 2 (config) |
| Replay | idempotent ids, signed `sent_at`, optional `expires_at`, rate limits | 0 (same) / 7 (changed) |
| Forgery | HMAC signatures, configured sources, signed webhooks | 4 |
| Path traversal | plain file names, `report_roots` containment with symlink resolution | 5 (sink refused) |
| Injection | content is data, no URLs/secrets, no unknown fields | 1 |
