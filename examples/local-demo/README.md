# Two-terminal local demo (no Bot or credentials)

Requires Node.js 22+. From a source checkout first run `npm ci` and `npm run build`.
The published package includes the build. No global installation is needed.

Terminal A (POSIX shell; use equivalent absolute paths in PowerShell):

```sh
DEMO=/absolute/path/to/wake-grokbot/examples/local-demo/demo.mjs
mkdir demo-run
cd demo-run
node "$DEMO" init
node "$DEMO" send
```

Terminal B: set `DEMO` to the same absolute script path, `cd` to the **same demo-run directory**, then:

```sh
node "$DEMO" reply
```

Terminal A:

```sh
node "$DEMO" receive
node "$DEMO" status
```

Expect `done` in status, `Ready: Greeting ready` in `reports/greeting.md`, a matching
`reports/greeting.md.DONE`, and two local nudges in `wake.log`. The dispatcher sends a task;
the worker acknowledges it and sends a receipt back; the dispatcher reads and acknowledges the receipt.
The script wake only logs a nudge: it does not do the work or launch another Bot.
The demo wraps the public CLI `send`, `ack`, `reply`, `status` commands and generates config plus
one envelope; inspect `demo.mjs` and `task.json`. All state is isolated under the current directory.
`init` and `send` refuse to overwrite existing demo files: use a new empty directory to try again.

Wake acceptance, task claim, report creation and receipt consumption are distinct steps.
Never resend blindly when a receipt is missing: inspect status, inbox, report/marker and wake.log first.
Tasks do not grant permissions; never put URLs or secrets in envelopes. For deployment topology and
Grok Bot routines see [Getting started](../../docs/getting-started.md).
