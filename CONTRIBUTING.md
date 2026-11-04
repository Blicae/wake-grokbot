# Contributing

Thanks for helping.

## Setup

Node.js 22 or newer.

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

## Rules

- Keep runtime dependencies at zero. Dev dependencies are fine.
- Tests must never call a real webhook: use the local stub server in `tests/helpers.ts`.
- Tests run in temporary HOME/APPDATA/LOCALAPPDATA/XDG folders; never touch the real user folders.
- Never commit real config, URLs with tokens, keys or personal data. Use `example.invalid` in examples.
- Change the protocol only together with `schema/`, `fixtures/` and `docs/protocol.md`.
- Works on Windows, macOS and Linux: no shell-only tricks; use the atomic file helpers in `src/fsutil.ts`.
