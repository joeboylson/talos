#!/bin/sh
# Takes talos off this machine: the launch agent that runs it at login, the
# session runner and every session in it, the `talos` command, and ~/.talos
# (the machine's key, its folder list, the downloaded copy, logs).
#
#   curl -fsSL https://raw.githubusercontent.com/joeboylson/talos/main/uninstall.sh | sh
#
# The page still lists the machine; remove it there too.
set -eu

TALOS_HOME="${TALOS_HOME:-$HOME/.talos}"
BIN_FILE="$HOME/.local/bin/talos"
LAUNCH_AGENT_LABEL="local.talos"
LAUNCH_AGENT="$HOME/Library/LaunchAgents/$LAUNCH_AGENT_LABEL.plist"

say() { printf 'talos: %s\n' "$1"; }

# A TALOS_HOME that's empty or the home folder itself would take everything
# with it.
case "$TALOS_HOME" in
  "" | "/" | "$HOME" | "$HOME/") say "won't remove $TALOS_HOME" >&2; exit 1 ;;
esac

if [ -f "$LAUNCH_AGENT" ]; then
  launchctl bootout "gui/$(id -u)/$LAUNCH_AGENT_LABEL" 2>/dev/null || true
  rm -f "$LAUNCH_AGENT"
  say "no longer runs at login"
fi

# The session runner ends its sessions when it's told to stop. Its lock holds
# its process id; one left by a runner that died may name another program by
# now, so it's checked first. One that won't stop in 10 s is killed.
RUNNER_PID="$(cat "$TALOS_HOME/runner.lock" 2>/dev/null || true)"
if [ -n "$RUNNER_PID" ] && ps -o command= -p "$RUNNER_PID" 2>/dev/null | grep -q "session-runner" && kill "$RUNNER_PID" 2>/dev/null; then
  WAITED=0
  while kill -0 "$RUNNER_PID" 2>/dev/null && [ "$WAITED" -lt 50 ]; do sleep 0.2; WAITED=$((WAITED + 1)); done
  kill -9 "$RUNNER_PID" 2>/dev/null || true
  say "ended the session runner and its sessions"
fi

rm -f "$BIN_FILE"
rm -rf "$TALOS_HOME"
say "removed $TALOS_HOME and the talos command; remove this machine on the page too"
