# Claude Code hook example

Wakes the dispatcher with one `note` whenever a Claude Code session (or a subagent) stops.

1. Copy `stop-hook.mjs` to `.claude/hooks/stop-hook.mjs` in your project.
2. Merge `settings.json` into `.claude/settings.json` (project) or `~/.claude/settings.json` (user).
3. On Windows, set `WAKE_GROKBOT_HOOK_CLI` to `node|<path>\dist\cli.js` of an installed wake-grokbot.
   Elsewhere `wake-grokbot` on `PATH` is used.

The note carries only the project folder name. The dispatcher reads the inbox and decides what to do.
Remove `SubagentStop` if you only want one note per session. `WAKE_GROKBOT_DISABLED=1` silences it.
