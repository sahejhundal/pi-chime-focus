# pi-chime-focus

Rich, clickable, self-clearing "agent is ready" notifications for [Pi](https://github.com/earendil-works/pi).

When the agent finishes a turn it posts a desktop notification where:

- **title** = the Pi session title (the same auto-generated/renamed title the tab shows)
- **message** = the agent's last message
- **click it** → jumps focus to the exact iTerm2 window/tab/session that pi runs in
- **focus that tab** → the notification clears itself (per-tab)

It degrades gracefully: without `terminal-notifier` it falls back to a plain
(non-clickable) macOS notification; on non-macOS it uses terminal OSC notifications.

## Requirements

- macOS + **iTerm2** for the clickable + self-clearing behavior (the core features).
- [`terminal-notifier`](https://github.com/julienXX/terminal-notifier) (installed by the setup script).
- iTerm2 **Python API** enabled (for the focus-clear daemon).

## Install

### 1. Add the package to Pi

Edit `~/.pi/agent/settings.json` and add to the `packages` array:

```json
{
  "packages": [
    "git:https://github.com/sahejhundal/pi-chime-focus"
  ]
}
```

(Or run it ad hoc for one session: `pi --extension /path/to/pi-chime-focus/index.ts`.)

### 2. Install the macOS dependencies + daemon

Clone the repo and run the setup script (installs `terminal-notifier`, copies it to
`~/Applications` so its notification permission resolves, and installs the iTerm daemon):

```bash
git clone https://github.com/sahejhundal/pi-chime-focus
cd pi-chime-focus
./scripts/install-deps.sh
```

Then do the two one-time manual steps the script prints:

1. **System Settings → Notifications → terminal-notifier → Allow Notifications = ON.**
2. **iTerm2 → Settings → General → Magic → Enable Python API**, then
   **iTerm2 menu → Scripts → AutoLaunch → pi-chime-clear.py** (first run downloads
   iTerm's Python runtime; accept it). It auto-starts on every iTerm launch after that.

> You can also install just the daemon from inside Pi: run `/chime-focus` →
> **Install / update iTerm focus-clear daemon**. (You still enable the Python API
> and start it from the Scripts menu.)

## How it works

Three cooperating pieces:

1. **The pi extension** (`index.ts`) — on `agent_end` posts a `terminal-notifier`
   notification grouped `pi-chime-<iTerm session id>`. It waits briefly for the
   session's auto-title so the notification title matches the tab. On `-execute`
   (click) it runs a script that selects that iTerm session. On user `input` it
   removes its own notification (so typing in the tab clears a stale one).
2. **`terminal-notifier`** in `~/Applications` — delivers clickable notifications and
   supports programmatic removal (`-remove <group>`).
3. **The iTerm2 daemon** (`iterm/pi-chime-clear.py`, AutoLaunch) — uses the iTerm
   Python `FocusMonitor`. When you switch INTO a tab (a real focus transition) it
   removes that tab's notification group. Per-tab by design.

### Clearing rules

- Notification appears while you are **not** on its tab → focusing that tab clears it.
- Notification appears while you **are** on its tab → it stays (so you don't miss it);
  it clears when you either **switch away and back** to the tab, or **type / send input**
  in that pi session.

## Config

`~/.config/pi-chime-focus/config.json`

```json
{ "sound": "Glass", "enabled": true }
```

- `sound`: a macOS system sound name (`Glass`, `Purr`, `Hero`, `Ping`), or `"none"`.
- `enabled`: set `false` to mute.

Settings UI: `/chime-focus` inside Pi (test, change sound, toggle, install daemon).

## Troubleshooting

- **No notifications**: run `~/Applications/terminal-notifier.app/Contents/MacOS/terminal-notifier -diagnose`.
  `authorization: denied` → enable it in System Settings → Notifications.
- **Not clearing on focus**: check the daemon is running (`pgrep -fl pi-chime-clear.py`)
  and the Python API is enabled. See `~/.config/pi-chime-focus/clear.log`.
- **Title shows `Pi · <folder>`**: the session had no title yet and auto-title didn't
  run within the wait window; a titled session shows its real title.

## License

MIT
