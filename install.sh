#!/bin/sh
# Installs talos on this machine, or updates it, with no git checkout: it
# downloads main from GitHub into ~/.talos/app and puts a `talos` command in
# ~/.local/bin. The first time, give the server's address:
#
#   curl -fsSL https://raw.githubusercontent.com/joeboylson/talos/main/install.sh | sh -s -- wss://<server>
#
# Then `talos service install` pairs this machine and runs talos in the
# background, at every login. Later, `talos update` (or this script again, with
# no address) updates it.
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

# talos runs on its own copy of the one Bun it's tested with, kept in
# ~/.talos/bun, whatever Bun the machine has: an older Bun gives sessions no
# terminal, and Claude Code then quits at once. It's checked against Bun's own
# published checksums. Bun's installer isn't used: it edits shell start-up files.
BUN_VERSION="1.4.4"
BUN_HOME="$TALOS_HOME/bun"
BUN="$BUN_HOME/bun"
BUN_CHANGED=0
if [ ! -x "$BUN" ] || [ "$("$BUN" --version 2>/dev/null)" != "$BUN_VERSION" ]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) BUN_BUILD="bun-darwin-aarch64" ;;
    Darwin-x86_64) BUN_BUILD="bun-darwin-x64" ;;
    Linux-x86_64) BUN_BUILD="bun-linux-x64" ;;
    Linux-aarch64 | Linux-arm64) BUN_BUILD="bun-linux-aarch64" ;;
    *) say "no Bun build for $(uname -s) $(uname -m)" >&2; exit 1 ;;
  esac
  BUN_RELEASE="https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION"
  BUN_DOWNLOAD="$TALOS_HOME/$BUN_BUILD.zip"
  curl -fsSL --retry 3 -o "$BUN_DOWNLOAD" "$BUN_RELEASE/$BUN_BUILD.zip"
  EXPECTED="$(curl -fsSL --retry 3 "$BUN_RELEASE/SHASUMS256.txt" | grep " $BUN_BUILD.zip\$" | cut -d' ' -f1)"
  if command -v sha256sum >/dev/null 2>&1; then ACTUAL="$(sha256sum "$BUN_DOWNLOAD" | cut -d' ' -f1)"; else ACTUAL="$(shasum -a 256 "$BUN_DOWNLOAD" | cut -d' ' -f1)"; fi
  if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then
    rm -f "$BUN_DOWNLOAD"
    say "the Bun download didn't match Bun's checksum; nothing changed" >&2
    exit 1
  fi
  rm -rf "$BUN_HOME" "$TALOS_HOME/$BUN_BUILD"
  unzip -q "$BUN_DOWNLOAD" -d "$TALOS_HOME"
  mv "$TALOS_HOME/$BUN_BUILD" "$BUN_HOME"
  rm -f "$BUN_DOWNLOAD"
  BUN_CHANGED=1
fi

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
# sessions) when its own code changed. That's talos-sessions' files (its mod
# is read from disk) and everything session-runner.ts loads, like loops, which
# bundling it gathers. cksum is on every system, and only tells a change.
sessions_hash() {
  if [ -d "$1/talos/src/talos-sessions" ]; then
    (cd "$1/talos/src/talos-sessions" && find . -type f -not -path './tests/*' -not -path './examples/*' | LC_ALL=C sort | xargs cat | cksum)
    (cd "$1" && "$BUN" build talos/src/session-runner.ts --target bun 2>/dev/null | cksum)
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

# Running in the background (a launch agent on macOS, a systemd user service
# on Linux), or asked to by `talos update`: `talos service install` from the
# new copy sets it up again and restarts it. It pairs first if it must, so it
# gets the terminal when there is one (piped into sh, stdin isn't it).
has_service() { [ -f "$LAUNCH_AGENT" ] || [ -f "$SYSTEMD_UNIT" ]; }
install_service() {
  if (: </dev/tty) 2>/dev/null; then "$BIN_DIR/talos" service install </dev/tty; else "$BIN_DIR/talos" service install; fi
}
if [ "${TALOS_INSTALL_SERVICE:-}" = "1" ] || has_service; then
  if [ "$OLD_VERSION" != "none" ] && { [ "$OLD_SESSIONS" != "$NEW_SESSIONS" ] || [ "$BUN_CHANGED" = "1" ]; }; then
    say "the session runner changed; restarting it ends its sessions"
    "$BIN_DIR/talos" runner stop || true
  fi
  # The update is in place either way; a service that won't set up is said as such.
  install_service || say "updated, but couldn't set up the background service; run: talos service install"
elif [ "$OLD_VERSION" = "none" ]; then
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) say "add $BIN_DIR to your PATH to run talos by name" ;;
  esac
  say "next: talos service install (pairs this machine, then runs talos in the background)"
fi
