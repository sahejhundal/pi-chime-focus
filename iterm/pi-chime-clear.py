#!/usr/bin/env python3
"""
pi-chime-clear — iTerm2 AutoLaunch daemon.

When an iTerm2 session gains keyboard focus (tab switch, window switch, pane
switch, or app re-activation), it removes that session's pi chime-focus
notification group (`pi-chime-<session id>`) via terminal-notifier.

This pairs with the `chime-focus` pi extension, which posts notifications with
`-group pi-chime-<ITERM_SESSION_ID guid>`. Because the group is per iTerm
session id, focusing one tab only clears that tab's notification.

Requires: iTerm2 Python API enabled (Settings > General > Magic > Enable Python
API). Logs session ids it sees to ~/.config/pi-chime-focus/clear.log so the id
scheme can be verified against $ITERM_SESSION_ID.
"""

import asyncio
import os
import subprocess
from datetime import datetime

import iterm2

_CANDIDATES = [
    os.path.expanduser("~/Applications/terminal-notifier.app/Contents/MacOS/terminal-notifier"),
    "/Applications/terminal-notifier.app/Contents/MacOS/terminal-notifier",
    "/opt/homebrew/bin/terminal-notifier",
    "/usr/local/bin/terminal-notifier",
]
TN = next((p for p in _CANDIDATES if os.path.exists(p)), None)

LOG_PATH = os.path.expanduser("~/.config/pi-chime-focus/clear.log")


def log(msg: str) -> None:
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        with open(LOG_PATH, "a") as f:
            f.write(f"{datetime.now().isoformat(timespec='seconds')} {msg}\n")
    except Exception:
        pass


def remove_group(session_id: str | None) -> None:
    if not session_id or not TN:
        return
    group = f"pi-chime-{session_id}"
    try:
        subprocess.run(
            [TN, "-remove", group],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
        )
        log(f"removed {group}")
    except Exception as e:  # noqa: BLE001
        log(f"remove error for {group}: {e}")


async def main(connection):
    app = await iterm2.async_get_app(connection)
    log(f"started; terminal-notifier={TN}")

    def focused_session_id() -> str | None:
        win = app.current_terminal_window
        if win is None:
            return None
        tab = win.current_tab
        if tab is None:
            return None
        sess = tab.current_session
        return sess.session_id if sess else None

    # Seed the "currently focused" session WITHOUT clearing. We only clear on a
    # real transition INTO a session (prev != now). This means: a notification
    # that appears while you are already on its tab is NOT wiped by a spurious
    # same-tab focus event; it stays until you switch away and back (or type,
    # which the pi extension handles on its own).
    last_focused = focused_session_id()
    log(f"seeded focus = {last_focused}")

    async with iterm2.FocusMonitor(connection) as monitor:
        while True:
            update = await monitor.async_get_next_update()

            # App went to the background -> ignore. Keep last_focused so that
            # returning to the SAME tab (app switch, not tab switch) is not a
            # transition and does not clear.
            app_active = update.application_active
            if app_active is not None and not getattr(app_active, "active", True):
                continue

            if update.active_session_changed is not None:
                sid = update.active_session_changed.session_id
            else:
                # tab / window / app-activate change -> resolve current session
                sid = focused_session_id()

            if sid is None:
                # Unknown focus (no current window); don't treat as a transition.
                continue

            if sid != last_focused:
                log(f"transition {last_focused} -> {sid}; clearing {sid}")
                remove_group(sid)
                last_focused = sid
            else:
                log(f"same focus {sid}; no clear")


iterm2.run_forever(main)
