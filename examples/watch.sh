#!/bin/sh
# Run `wake-grokbot watch --once` on a schedule (Linux/macOS).
# Keep the wake URL and key in the environment (e.g. a file readable only by you), never in this script.
#
# cron (every 5 minutes):
#   */5 * * * * . "$HOME/.config/wake-grokbot/env" && /path/to/watch.sh
#
# systemd user timer:
#   ~/.config/systemd/user/wake-grokbot-watch.service
#     [Service]
#     Type=oneshot
#     EnvironmentFile=%h/.config/wake-grokbot/env
#     ExecStart=/usr/bin/env npx --yes wake-grokbot watch --once
#   ~/.config/systemd/user/wake-grokbot-watch.timer
#     [Timer]
#     OnBootSec=2min
#     OnUnitActiveSec=5min
#     [Install]
#     WantedBy=timers.target
#   systemctl --user enable --now wake-grokbot-watch.timer
#
# launchd (macOS): a LaunchAgent with ProgramArguments = [npx, --yes, wake-grokbot, watch, --once]
# and StartInterval = 300.
#
# Or run it in the foreground: wake-grokbot watch --interval 300
set -eu
if command -v wake-grokbot >/dev/null 2>&1; then
  exec wake-grokbot watch --once
else
  exec npx --yes wake-grokbot watch --once
fi
