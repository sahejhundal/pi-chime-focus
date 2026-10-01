/**
 * chime-focus — rich, clickable "agent is ready" notifications for Pi.
 *
 * On `agent_end` it posts a desktop notification where:
 *   • title   = the Pi session title (falls back to "Pi · <cwd basename>")
 *   • message = the agent's last message (truncated)
 * On macOS + iTerm2, clicking the notification focuses the exact iTerm
 * window/tab/session that this Pi process is running in.
 *
 * Backends (auto-detected at runtime, best first):
 *   1. terminal-notifier  — rich title+message, clickable -> focus session.
 *                           Requires its notification permission to be on
 *                           (System Settings > Notifications > terminal-notifier).
 *   2. osascript display notification — title+message, NOT clickable. Used as
 *                           a fallback when terminal-notifier is missing or
 *                           not authorized (exit code 3/4/5).
 *   3. OSC / BEL          — non-macOS terminal-native fallback.
 *
 * Config: ~/.config/pi-chime-focus/config.json  { "sound": "Glass", "enabled": true }
 * Command: /chime-focus  — test + change sound.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

// ── Config ───────────────────────────────────────────────────────────────────

interface ChimeConfig {
  sound?: string;
  enabled?: boolean;
}

const CONFIG_DIR = join(homedir(), ".config", "pi-chime-focus");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const FOCUS_SCRIPT = join(CONFIG_DIR, "focus-iterm.sh");

const DEFAULT_SOUND = "Glass";
const AVAILABLE_SOUNDS = [
  { name: "Glass", description: "Clear timer-like" },
  { name: "Purr", description: "Soft and pleasant" },
  { name: "Hero", description: "Triumphant" },
  { name: "Ping", description: "Short blip" },
  { name: "none", description: "No sound" },
];

const loadConfig = (): ChimeConfig => {
  try {
    if (existsSync(CONFIG_PATH)) return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as ChimeConfig;
  } catch {
    /* ignore */
  }
  return {};
};

const saveConfig = (config: ChimeConfig): void => {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  } catch {
    /* ignore */
  }
};

const getSound = (): string | undefined => {
  const s = loadConfig().sound ?? DEFAULT_SOUND;
  return s && s.toLowerCase() !== "none" ? s : undefined;
};

const isEnabled = (): boolean => loadConfig().enabled !== false;

// ── Platform / terminal detection ─────────────────────────────────────────────

const isDarwin = process.platform === "darwin";

/** iTerm2 session GUID for this process, parsed from ITERM_SESSION_ID (`wNtNpN:GUID`). */
const itermGuid = (): string | undefined => {
  const raw = process.env.ITERM_SESSION_ID;
  if (!raw) return undefined;
  const guid = raw.includes(":") ? raw.slice(raw.indexOf(":") + 1) : raw;
  // Only accept a clean UUID so it is safe to embed in AppleScript / argv.
  return /^[0-9A-Fa-f-]{10,}$/.test(guid) ? guid : undefined;
};

/** Locate the terminal-notifier binary, preferring the ~/Applications copy
 *  (its bundle path must live in /Applications or ~/Applications for the
 *  notification permission to resolve). Cached after first lookup. */
let tnPathCache: string | null | undefined;
const terminalNotifierPath = (): string | null => {
  if (tnPathCache !== undefined) return tnPathCache;
  const candidates = [
    join(homedir(), "Applications", "terminal-notifier.app", "Contents", "MacOS", "terminal-notifier"),
    "/Applications/terminal-notifier.app/Contents/MacOS/terminal-notifier",
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      tnPathCache = c;
      return c;
    }
  }
  try {
    const p = execFileSync("command", ["-v", "terminal-notifier"], { encoding: "utf-8" }).trim();
    if (p) {
      tnPathCache = p;
      return p;
    }
  } catch {
    /* not found */
  }
  tnPathCache = null;
  return null;
};

// ── Focus helper script (written once) ─────────────────────────────────────────

const ensureFocusScript = (): void => {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    const script = `#!/bin/bash
# Focus an iTerm2 session by its session id (GUID). Written by pi chime-focus.
GUID="$1"
[ -z "$GUID" ] && exit 0
/usr/bin/osascript <<OSA
tell application "iTerm2"
  activate
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if (id of s) is "$GUID" then
          select w
          select t
          select s
        end if
      end repeat
    end repeat
  end repeat
end tell
OSA
`;
    writeFileSync(FOCUS_SCRIPT, script, { mode: 0o755 });
  } catch {
    /* ignore */
  }
};

// ── Message helpers ─────────────────────────────────────────────────────────

const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

interface AnyMsg {
  role?: string;
  content?: unknown;
}

const extractText = (c: unknown): string => {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter((p): p is { type: string; text: string } => Boolean(p && typeof p === "object" && (p as any).type === "text" && typeof (p as any).text === "string"))
      .map((p) => p.text)
      .join(" ");
  }
  return "";
};

const lastAssistantText = (messages: readonly AnyMsg[]): string => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    const text = oneLine(extractText(m.content));
    if (text) return truncate(text, 220);
  }
  return "Ready for input";
};

const firstUserText = (messages: readonly AnyMsg[]): string => {
  for (const m of messages) {
    if (!m || m.role !== "user") continue;
    const text = oneLine(extractText(m.content));
    if (text) return truncate(text, 60);
  }
  return "";
};

type SessionCtx = {
  sessionManager?: { getSessionName?: () => string | undefined; getCwd?: () => string };
};

const currentSessionName = (ctx: SessionCtx): string | undefined => {
  try {
    const name = ctx.sessionManager?.getSessionName?.();
    return name && name.trim() ? name.trim() : undefined;
  } catch {
    return undefined;
  }
};

const cwdFallbackTitle = (ctx: SessionCtx): string => {
  try {
    const cwd = ctx.sessionManager?.getCwd?.() ?? process.cwd();
    return `Pi · ${basename(cwd) || "session"}`;
  } catch {
    return "Pi";
  }
};

// ── Notification backends ──────────────────────────────────────────────────────

const escapeAppleScript = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const notifyOsascript = (title: string, body: string, sound?: string): void => {
  const soundArg = sound ? ` sound name "${escapeAppleScript(sound)}"` : "";
  const script = `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}"${soundArg}`;
  execFile("osascript", ["-e", script], () => {});
};

const notifyTerminalNotifier = (
  bin: string,
  title: string,
  body: string,
  guid: string | undefined,
  sound: string | undefined,
  onUnauthorized: () => void,
): void => {
  const args = ["-title", title, "-message", body || " "];
  if (guid) {
    args.push("-group", `pi-chime-${guid}`);
    args.push("-execute", `"${FOCUS_SCRIPT}" ${guid}`);
  }
  if (sound) args.push("-sound", sound);
  execFile(bin, args, (err) => {
    // Exit 3 = not authorized, 4 = no GUI, 5 = refused. Fall back so the user
    // still gets *some* notification.
    const code = (err as { code?: number } | null)?.code;
    if (err && (code === 3 || code === 4 || code === 5)) onUnauthorized();
  });
};

/** Remove this session's own notification group (e.g. when the user types in
 *  this tab, so the stale "ready" notification goes away immediately). */
const removeOwnGroup = (): void => {
  if (!isDarwin) return;
  const bin = terminalNotifierPath();
  const guid = itermGuid();
  if (!bin || !guid) return;
  execFile(bin, ["-remove", `pi-chime-${guid}`], () => {});
};

// ── OSC / BEL fallback (non-macOS) ──────────────────────────────────────────────

const notifyOSC = (title: string, body: string): void => {
  const msg = `${title}: ${body}`;
  if (process.env.KITTY_WINDOW_ID) {
    process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
    process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
    return;
  }
  // OSC 9 (iTerm/Ghostty/WezTerm) with OSC 777 + BEL as broad fallbacks.
  process.stdout.write(`\x1b]9;${msg}\x07`);
  process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
  process.stdout.write("\x07");
};

// ── Main chime ─────────────────────────────────────────────────────────────────

const chime = (title: string, body: string): void => {
  const sound = getSound();
  if (isDarwin) {
    const bin = terminalNotifierPath();
    const guid = itermGuid();
    if (bin) {
      notifyTerminalNotifier(bin, title, body, guid, sound, () => notifyOsascript(title, body, sound));
      return;
    }
    notifyOsascript(title, body, sound);
    return;
  }
  notifyOSC(title, body);
};

// ── Settings menu ──────────────────────────────────────────────────────────────

// 
// 
const ITERM_AUTOLAUNCH_DIR = join(homedir(), "Library", "Application Support", "iTerm2", "Scripts", "AutoLaunch");

/** Copy the bundled iTerm focus-clear daemon into iTerm's AutoLaunch dir. Works
 *  only when installed as a package (the daemon lives next to this file under
 *  ./iterm/). Returns a human-readable result. */
const installDaemon = (): { ok: boolean; msg: string } => {
  try {
    let src: string;
    try {
      src = fileURLToPath(new URL("./iterm/pi-chime-clear.py", import.meta.url));
    } catch {
      return { ok: false, msg: "Could not resolve bundled daemon path. Copy iterm/pi-chime-clear.py from the repo into iTerm Scripts/AutoLaunch manually." };
    }
    if (!existsSync(src)) {
      return { ok: false, msg: "Bundled daemon not found (single-file install?). Copy iterm/pi-chime-clear.py from the repo into iTerm Scripts/AutoLaunch manually." };
    }
    mkdirSync(ITERM_AUTOLAUNCH_DIR, { recursive: true });
    const dest = join(ITERM_AUTOLAUNCH_DIR, "pi-chime-clear.py");
    writeFileSync(dest, readFileSync(src, "utf-8"), "utf-8");
    return {
      ok: true,
      msg: `Installed daemon -> ${dest}. Next: enable iTerm Python API (Settings > General > Magic > Enable Python API), then run it from Scripts > AutoLaunch > pi-chime-clear.py (no iTerm restart needed).`,
    };
  } catch (e) {
    return { ok: false, msg: `Install failed: ${String(e)}` };
  }
};

const showSettingsMenu = async (ctx: {
  ui: {
    select: (title: string, options: string[]) => Promise<string | undefined>;
    notify: (message: string, type?: "info" | "warning" | "error") => void;
  };
}): Promise<void> => {
  const cfg = loadConfig();
  const currentSound = cfg.sound ?? DEFAULT_SOUND;
  const enabled = cfg.enabled !== false;
  const bin = terminalNotifierPath();
  const backend = !isDarwin ? "terminal OSC" : bin ? "terminal-notifier (clickable)" : "osascript (not clickable)";

  const choice = await ctx.ui.select("Chime-Focus Settings", [
    "Test notification",
    `Change sound (current: ${currentSound})`,
    `Toggle notifications (currently: ${enabled ? "on" : "off"})`,
    "Install / update iTerm focus-clear daemon",
    `Backend: ${backend}`,
    "Exit",
  ]);

  if (choice === "Install / update iTerm focus-clear daemon") {
    const res = installDaemon();
    ctx.ui.notify(res.msg, res.ok ? "info" : "warning");
  } else if (choice === "Test notification") {
    chime("chime-focus test", "Click me to focus this Pi session.");
    ctx.ui.notify(`Chime sent via ${backend}`, "info");
  } else if (choice?.startsWith("Change sound")) {
    const selected = await ctx.ui.select(
      "Select notification sound",
      AVAILABLE_SOUNDS.map((s) => `${s.name} — ${s.description}`),
    );
    if (selected) {
      const soundName = selected.split(" — ")[0];
      if (soundName) {
        saveConfig({ ...loadConfig(), sound: soundName });
        ctx.ui.notify(`Notification sound set to: ${soundName}`, "info");
      }
    }
  } else if (choice?.startsWith("Toggle notifications")) {
    const next = !(loadConfig().enabled !== false);
    saveConfig({ ...loadConfig(), enabled: next });
    ctx.ui.notify(`Notifications ${next ? "enabled" : "disabled"}`, "info");
  }
};

// ── Entrypoint ───────────────────────────────────────────────────────────────

// When auto-title (pi-sessions) is generating a title for a fresh session, the
// title is produced by an async model call that often finishes AFTER agent_end.
// If we fire immediately we'd show the cwd fallback instead of the real title.
// So when there is no title yet, hold the notification and wait for the title
// to land (via session_info_changed, or a short re-check), with a timeout.
const TITLE_WAIT_MS = 4000;

interface PendingChime {
  body: string;
  firstUser: string;
  ctx: SessionCtx;
  timer: ReturnType<typeof setTimeout>;
}
let pending: PendingChime | null = null;

const clearPending = (): void => {
  if (pending) {
    clearTimeout(pending.timer);
    pending = null;
  }
};

export default (pi: ExtensionAPI): void => {
  if (isDarwin) ensureFocusScript();

  pi.on("agent_end", (event, ctx) => {
    if (!isEnabled()) return;
    try {
      const sctx = ctx as unknown as SessionCtx;
      const body = lastAssistantText(((event as any).messages ?? []) as AnyMsg[]);
      const firstUser = firstUserText(((event as any).messages ?? []) as AnyMsg[]);
      const title = currentSessionName(sctx);
      if (title) {
        clearPending();
        chime(title, body);
        return;
      }
      // No title yet — defer until one lands or we time out.
      clearPending();
      const timer = setTimeout(() => {
        const p = pending;
        pending = null;
        if (!p) return;
        const late = currentSessionName(p.ctx);
        chime(late ?? p.firstUser ?? cwdFallbackTitle(p.ctx) ?? "Pi", p.body);
      }, TITLE_WAIT_MS);
      pending = { body, firstUser, ctx: sctx, timer };
    } catch {
      /* never let a notification failure break the agent loop */
    }
  });

  // User typed / sent input in this tab -> they're engaged here, so drop this
  // session's stale notification (covers "type to clear" while staying on tab).
  pi.on("input", () => {
    try {
      clearPending();
      removeOwnGroup();
    } catch {
      /* ignore */
    }
  });

  // Auto-title / manual rename lands here — fire the held notification with it.
  pi.on("session_info_changed", (event) => {
    if (!pending) return;
    const name = (event as any)?.name as string | undefined;
    if (name && name.trim()) {
      const p = pending;
      clearPending();
      chime(name.trim(), p.body);
    }
  });

  pi.registerCommand("chime-focus", {
    description: "Chime-Focus settings — test, change sound, toggle",
    handler: async (_args, ctx) => {
      await showSettingsMenu(ctx);
    },
  });
};
