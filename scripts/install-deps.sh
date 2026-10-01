#!/usr/bin/env bash
# pi-chime-focus — install the macOS dependencies (terminal-notifier) and the
# iTerm2 focus-clear daemon. Safe to re-run (idempotent).
set -euo pipefail

echo "==> pi-chime-focus dependency installer"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "Not macOS. The clickable/self-clearing features are macOS + iTerm2 only."
  echo "On other platforms the extension falls back to terminal OSC notifications. Nothing to install."
  exit 0
fi

# 1. terminal-notifier (clickable notifications + programmatic -remove).
if ! command -v terminal-notifier >/dev/null 2>&1 \
   && [[ ! -x "$HOME/Applications/terminal-notifier.app/Contents/MacOS/terminal-notifier" ]]; then
  echo "==> Installing terminal-notifier via Homebrew..."
  brew install terminal-notifier
fi

# 2. Copy terminal-notifier.app into ~/Applications. Its notification
#    permission (TCC) only resolves when the bundle lives in /Applications or
#    ~/Applications — NOT the Homebrew Cellar.
CELLAR_APP="$(brew --prefix 2>/dev/null)/opt/terminal-notifier/terminal-notifier.app"
if [[ -d "$CELLAR_APP" && ! -d "$HOME/Applications/terminal-notifier.app" ]]; then
  echo "==> Copying terminal-notifier.app to ~/Applications (needed for notification permission)..."
  mkdir -p "$HOME/Applications"
  cp -R "$CELLAR_APP" "$HOME/Applications/terminal-notifier.app"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
    -f "$HOME/Applications/terminal-notifier.app" || true
fi

# 3. Install the iTerm2 focus-clear daemon into AutoLaunch.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_DIR="$HOME/Library/Application Support/iTerm2/Scripts/AutoLaunch"
echo "==> Installing iTerm focus-clear daemon to: $DEST_DIR"
mkdir -p "$DEST_DIR"
cp "$SCRIPT_DIR/iterm/pi-chime-clear.py" "$DEST_DIR/pi-chime-clear.py"

cat <<'NEXT'

==> Done. Two one-time manual steps remain:

  1. Grant notification permission:
     Open System Settings > Notifications > terminal-notifier > Allow Notifications = ON.
     (If terminal-notifier is not listed yet, fire one test notification first:
        ~/Applications/terminal-notifier.app/Contents/MacOS/terminal-notifier -message hi -title test )

  2. Enable + start the iTerm focus-clear daemon:
     - iTerm2 > Settings > General > Magic > check "Enable Python API" (accept the prompt).
     - iTerm2 menu bar > Scripts > AutoLaunch > pi-chime-clear.py
       (first run downloads iTerm's bundled Python runtime — accept it).
     It auto-starts on every iTerm launch after that.

Verify: ~/.config/pi-chime-focus/clear.log should show focus events as you switch tabs.
NEXT
