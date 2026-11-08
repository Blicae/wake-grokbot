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
#     ExecStart=/usr/bin/env npx --yes wake-grokbot@0.2.0 --config %h/.config/wake-grokbot/wake-grokbot.json watch --once
#   ~/.config/systemd/user/wake-grokbot-watch.timer
#     [Timer]
#     OnBootSec=2min
#     OnUnitActiveSec=5min
#     [Install]
#     WantedBy=timers.target
#   systemctl --user enable --now wake-grokbot-watch.timer
#
# launchd (macOS): a LaunchAgent with ProgramArguments = [npx, --yes, wake-grokbot@0.2.0, --config, <config file>, watch, --once]
# and StartInterval = 300.
#
# Or run it in the foreground: wake-grokbot watch --interval 300
set -eu
# Pinned version and explicit config (override with WAKE_GROKBOT_VERSION / WAKE_GROKBOT_CONFIG).
VERSION="${WAKE_GROKBOT_VERSION:-0.2.0}"
CONFIG="${WAKE_GROKBOT_CONFIG:-$HOME/.config/wake-grokbot/wake-grokbot.json}"
# A global install is used only when it is exactly the pinned version; a different version is an error.
if command -v wake-grokbot >/dev/null 2>&1; then
  HAVE="$(wake-grokbot --version 2>/dev/null || true)"
  if [ "$HAVE" != "$VERSION" ]; then
    echo "watch.sh: global wake-grokbot is '$HAVE', pinned version is $VERSION; install wake-grokbot@$VERSION or remove the global one" >&2
    exit 2
  fi
  exec wake-grokbot --config "$CONFIG" watch --once
else
  exec npx --yes "wake-grokbot@$VERSION" --config "$CONFIG" watch --once
fi
