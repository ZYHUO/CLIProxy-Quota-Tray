#!/usr/bin/env bash
# Install a packaged linux-x64 build into the current user profile.
# Usage:
#   ./scripts/install-linux.sh
#   ./scripts/install-linux.sh "release/CLIProxy Quota Tray-linux-x64"

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${1:-$ROOT_DIR/release/CLIProxy Quota Tray-linux-x64}"
APP_NAME="CLIProxy Quota Tray"
INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/CLIProxy-Quota-Tray"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
EXEC_PATH="$INSTALL_DIR/$APP_NAME"
DESKTOP_PATH="$APP_DIR/cliproxy-quota-tray.desktop"

if [[ ! -d "$SRC" ]]; then
  echo "Packaged build not found: $SRC" >&2
  echo "Run: npm run package:linux" >&2
  exit 1
fi

if [[ ! -x "$SRC/$APP_NAME" && ! -f "$SRC/$APP_NAME" ]]; then
  echo "Executable missing in build: $SRC/$APP_NAME" >&2
  exit 1
fi

desktop_exec_quote() {
  local value="$1"
  if [[ "$value" =~ [[:space:]\"\\] ]]; then
    value="${value//\\/\\\\}"
    value="${value//\"/\\\"}"
    printf '"%s"' "$value"
  else
    printf '%s' "$value"
  fi
}

mkdir -p "$INSTALL_DIR" "$BIN_DIR" "$APP_DIR"
rsync -a --delete "$SRC/" "$INSTALL_DIR/"
chmod +x "$EXEC_PATH" || true

cat > "$DESKTOP_PATH" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=CLIProxy Quota Tray
Comment=CLIProxyAPI OAuth quota tray dashboard
Exec=$(desktop_exec_quote "$EXEC_PATH")
TryExec=$EXEC_PATH
Terminal=false
Categories=Utility;Network;
StartupNotify=false
X-GNOME-UsesNotifications=false
EOF

ln -sfn "$EXEC_PATH" "$BIN_DIR/cliproxy-quota-tray"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APP_DIR" >/dev/null 2>&1 || true
fi

echo "Installed to: $INSTALL_DIR"
echo "Launcher:     $DESKTOP_PATH"
echo "Command:      $BIN_DIR/cliproxy-quota-tray"
echo
echo "Start now:    cliproxy-quota-tray --show"
echo "Autostart is created on first launch (~/.config/autostart/cliproxy-quota-tray.desktop)."
