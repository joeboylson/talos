#!/bin/sh
# Installs talos on this machine, or updates it, with no git checkout: it
# downloads main from GitHub into ~/.talos/app and puts a `talos` command in
# ~/.local/bin. The first time, give the server's address:
#
#   curl -fsSL https://raw.githubusercontent.com/joeboylson/talos/main/install.sh | sh -s -- wss://<server>
#
# Then `talos install` pairs this machine and runs talos at login. Later,
# `talos update` (or this script again, with no address) updates it.
set -eu

REPO="joeboylson/talos"
BRANCH="main"
TALOS_HOME="${TALOS_HOME:-$HOME/.talos}"
APP="$TALOS_HOME/app"
NEW_APP="$TALOS_HOME/app.new"
ENV_FILE="$TALOS_HOME/talos.env"
BIN_DIR="$HOME/.local/bin"
LAUNCH_AGENT_LABEL="local.talos"
LAUNCH_AGENT="$HOME/Library/LaunchAgents/$LAUNCH_AGENT_LABEL.plist"
SYSTEMD_UNIT_NAME="talos.service"
SYSTEMD_UNIT="$HOME/.config/systemd/user/$SYSTEMD_UNIT_NAME"
SERVER_URL="${1:-}"

say() { printf 'talos: %s\n' "$1"; }

mkdir -p "$TALOS_HOME"
chmod 700 "$TALOS_HOME"
if [ -n "$SERVER_URL" ]; then
  printf 'TALOS_SERVER_URL=%s\nTALOS_LOGS_MODE=quiet\n' "$SERVER_URL" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi
if [ ! -f "$ENV_FILE" ]; then
  say "the first install needs the server's address: ... | sh -s -- wss://<server>" >&2
  exit 1
fi

# Bun runs talos. Its own installer puts it in ~/.bun if it isn't here.
if ! command -v bun >/dev/null 2>&1; then
  [ -x "$HOME/.bun/bin/bun" ] || curl -fsSL https://bun.sh/install | bash >/dev/null
  PATH="$HOME/.bun/bin:$PATH"
fi
BUN="$(command -v bun)"

# The commit main is at, so the download is exactly that one, and `talos
# update` can say which it's on. Unknown (GitHub's API is down or rate
# limited), main as it is.
COMMIT="$(curl -fsSL -H 'Accept: application/vnd.github.sha' "https://api.github.com/repos/$REPO/commits/$BRANCH" 2>/dev/null || true)"
REF="${COMMIT:-$BRANCH}"

# Only talos and the package it shares with the server; built aside, then
# swapped in, so a failed download leaves the running copy as it was.
rm -rf "$NEW_APP"
mkdir -p "$NEW_APP"
curl -fsSL --retry 3 "https://codeload.github.com/$REPO/tar.gz/$REF" | tar -xz -C "$NEW_APP" --strip-components=1 "talos-$REF/talos" "talos-$REF/talos-shared"
printf '{ "name": "talos-root", "private": true, "workspaces": ["talos", "talos-shared"] }\n' > "$NEW_APP/package.json"
printf '%s\n' "$REF" > "$NEW_APP/VERSION"
if ! (cd "$NEW_APP" && "$BUN" install --production >/dev/null 2>&1); then
  say "couldn't install talos's packages; the running copy is unchanged" >&2
  exit 1
fi

# The session runner outlives talos; it only needs a restart (which ends its
# sessions) when its own code changed. cksum is on every system, and only
# tells a change.
sessions_hash() {
  if [ -d "$1/talos/src/talos-sessions" ]; then
    (cd "$1/talos/src/talos-sessions" && find . -type f -not -path './tests/*' -not -path './examples/*' | LC_ALL=C sort | xargs cat | cksum)
  else
    echo none
  fi
}
OLD_SESSIONS="$(sessions_hash "$APP")"
NEW_SESSIONS="$(sessions_hash "$NEW_APP")"
OLD_VERSION="$(cat "$APP/VERSION" 2>/dev/null || echo none)"

rm -rf "$TALOS_HOME/app.old"
if [ -d "$APP" ]; then mv "$APP" "$TALOS_HOME/app.old"; fi
mv "$NEW_APP" "$APP"
rm -rf "$TALOS_HOME/app.old"

mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/talos" <<EOF
#!/bin/sh
exec "$BUN" --env-file="$ENV_FILE" "$APP/talos/src/index.ts" "\$@"
EOF
chmod 755 "$BIN_DIR/talos"

if [ "$OLD_VERSION" = "none" ]; then
  say "installed $REF"
elif [ "$OLD_VERSION" = "$REF" ]; then
  say "already on $REF"
else
  say "updated from $OLD_VERSION to $REF"
fi

# Running as a service (a launch agent on macOS, a systemd user service on
# Linux): it restarts on the new code now.
restart_service() {
  if [ -f "$LAUNCH_AGENT" ]; then
    launchctl kickstart -k "gui/$(id -u)/$LAUNCH_AGENT_LABEL" 2>/dev/null
  else
    systemctl --user restart "$SYSTEMD_UNIT_NAME" 2>/dev/null
  fi
}
if [ -f "$LAUNCH_AGENT" ] || [ -f "$SYSTEMD_UNIT" ]; then
  if [ "$OLD_SESSIONS" != "$NEW_SESSIONS" ]; then
    say "the session runner changed; restarting it ends its sessions"
    "$BIN_DIR/talos" runner stop || true
  fi
  # The update is in place either way; a restart that fails is said as such.
  if restart_service; then
    say "restarted"
  else
    say "updated, but couldn't restart it; run: talos install"
  fi
elif [ "$OLD_VERSION" = "none" ]; then
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) say "add $BIN_DIR to your PATH to run talos by name" ;;
  esac
  say "next: talos install (pairs this machine, then runs talos at login)"
fi
