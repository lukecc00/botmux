#!/bin/sh
set -eu

REPO="lukecc00/botmux"
REF="p/ai_open"
PREFIX="${BOTMUX_INSTALL_PREFIX:-$HOME/.local}"
APP_HOME="$PREFIX/share/botmux"
BIN_DIR="$PREFIX/bin"
STAMP="$(date -u +%Y%m%d%H%M%S)-$$"
RELEASE_DIR="$APP_HOME/releases/$STAMP"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/botmux-install.XXXXXX")"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT HUP INT TERM

say() {
  printf '%s\n' "[botmux] $*"
}

fail() {
  printf '%s\n' "[botmux] ERROR: $*" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || fail "git is required"
command -v node >/dev/null 2>&1 || fail "Node.js 22+ is required"

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
[ "$NODE_MAJOR" -ge 22 ] || fail "Node.js 22+ is required (found $(node --version))"

SOURCE_DIR="$TMP_DIR/source"
SSH_URL="git@github.com:$REPO.git"
HTTPS_URL="https://github.com/$REPO.git"

say "Downloading latest $REPO@$REF"
# Git reports counting, compressing, receiving, and resolving percentages even
# when GitHub's archive endpoint does not provide a Content-Length header.
clone_source() {
  label="$1"
  url="$2"
  attempt=1
  while [ "$attempt" -le 2 ]; do
    # The personal remote normally uses SSH. It remains reachable on hosts
    # where github.com/raw.githubusercontent.com HTTPS is filtered. BatchMode
    # prevents a Dashboard-triggered update from waiting for an interactive
    # password prompt; an operator-provided GIT_SSH_COMMAND is preserved.
    if GIT_TERMINAL_PROMPT=0 \
      GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new}" \
      git clone --depth 1 --filter=blob:none --single-branch --branch "$REF" --progress "$url" "$SOURCE_DIR"; then
      return 0
    fi
    rm -rf "$SOURCE_DIR"
    say "$label download failed (attempt $attempt/2)"
    attempt=$((attempt + 1))
    [ "$attempt" -gt 2 ] || sleep "$attempt"
  done
  return 1
}

# SSH is the primary path for the personal repository; HTTPS remains useful on
# machines without a GitHub SSH key.
clone_source "SSH" "$SSH_URL" || clone_source "HTTPS" "$HTTPS_URL" \
  || fail "failed to download $REPO@$REF over SSH and HTTPS"
REVISION="$(git -C "$SOURCE_DIR" rev-parse HEAD)"
SHORT_REVISION="$(printf '%.8s' "$REVISION")"
VERSION="$(node -p "require(process.argv[1]).version" "$SOURCE_DIR/dev-version.json")"
rm -rf "$SOURCE_DIR/.git"
[ -f "$SOURCE_DIR/package.json" ] || fail "downloaded archive is not a botmux source tree"

say "Installing locked dependencies"
if command -v bun >/dev/null 2>&1; then
  BUN_CMD="bun"
elif [ -x "$HOME/.bun/bin/bun" ]; then
  BUN_CMD="$HOME/.bun/bin/bun"
else
  fail "Bun 1.4+ is required. Install Bun first: https://bun.sh/docs/installation"
fi
(cd "$SOURCE_DIR" && $BUN_CMD install --frozen-lockfile)

say "Building botmux"
(cd "$SOURCE_DIR" && $BUN_CMD run build)
[ -x "$SOURCE_DIR/dist/cli.js" ] || fail "build completed without dist/cli.js"

# Persist the source identity beside the built release. Future CLI, Dashboard,
# and scheduled updates read this file and return to the same personal repo.
BOTMUX_META_REPO="$REPO" BOTMUX_META_REF="$REF" \
BOTMUX_META_REVISION="$REVISION" BOTMUX_META_VERSION="$VERSION" \
BOTMUX_META_PREFIX="$PREFIX" node -e '
  const fs = require("fs");
  const path = require("path");
  const info = {
    schemaVersion: 1, method: "github-source",
    repo: process.env.BOTMUX_META_REPO, ref: process.env.BOTMUX_META_REF,
    revision: process.env.BOTMUX_META_REVISION, version: process.env.BOTMUX_META_VERSION,
    prefix: path.resolve(process.env.BOTMUX_META_PREFIX), installedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(process.argv[1], ".botmux-install.json"), JSON.stringify(info, null, 2) + "\n");
' "$SOURCE_DIR"

mkdir -p "$APP_HOME/releases" "$BIN_DIR"
mv "$SOURCE_DIR" "$RELEASE_DIR"
# `mv -f temp current` follows a destination symlink-to-directory on GNU mv
# and moves temp INSIDE the old release instead of replacing the symlink. Node's
# renameSync replaces the symlink inode itself, atomically and portably.
BOTMUX_RELEASE_DIR="$RELEASE_DIR" BOTMUX_APP_HOME="$APP_HOME" BOTMUX_BIN_DIR="$BIN_DIR" node -e '
  const fs = require("fs");
  const path = require("path");
  function replaceSymlink(target, link) {
    const tmp = `${link}.${process.pid}.new`;
    try { fs.unlinkSync(tmp); } catch {}
    fs.symlinkSync(target, tmp);
    try { fs.renameSync(tmp, link); }
    catch (error) { try { fs.unlinkSync(tmp); } catch {} throw error; }
  }
  replaceSymlink(process.env.BOTMUX_RELEASE_DIR, path.join(process.env.BOTMUX_APP_HOME, "current"));
  replaceSymlink(path.join(process.env.BOTMUX_APP_HOME, "current", "dist", "cli.js"), path.join(process.env.BOTMUX_BIN_DIR, "botmux"));
'

say "Installed v$VERSION ($REPO@$REF, $SHORT_REVISION)"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "Add to your shell profile: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
