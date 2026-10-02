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


KEYSTROKE_COOLDOWN = 1.5  # seconds between keystroke-triggered removes per session


async def main(connection):
    import asyncio
    import time

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

    # ---- focus loop: clear on a real transition INTO a session -------------
    # A notification that appears while you are already on its tab is NOT wiped
    # by a spurious same-tab focus event; it stays until you switch away and
    # back (handled here) or type (handled by the keystroke loop below).
    async def focus_loop():
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
                    sid = focused_session_id()

                if sid is None:
                    continue

                nonlocal_last[0] = sid  # keep keystroke loop's view in sync
                if sid != last_focused:
                    log(f"transition {last_focused} -> {sid}; clearing {sid}")
                    remove_group(sid)
                    last_focused = sid
                else:
                    log(f"same focus {sid}; no clear")

    # ---- keystroke loop: typing in a tab clears that tab's notification ----
    # Keystroke objects carry no session id, but keystrokes go to the focused
    # session, so we resolve the focused session at keypress time. Throttled per
    # session so we don't spawn a terminal-notifier process on every keypress.
    nonlocal_last = [focused_session_id()]
    last_cleared: dict[str, float] = {}

    async def keystroke_loop():
        async with iterm2.KeystrokeMonitor(connection) as monitor:
            while True:
                await monitor.async_get()
                sid = focused_session_id()
                if not sid:
                    continue
                now = time.monotonic()
                if now - last_cleared.get(sid, 0.0) < KEYSTROKE_COOLDOWN:
                    continue
                last_cleared[sid] = now
                log(f"keystroke in {sid}; clearing {sid}")
                remove_group(sid)

    await asyncio.gather(focus_loop(), keystroke_loop())


iterm2.run_forever(main)
