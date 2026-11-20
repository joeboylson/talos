import { homedir } from "node:os";
import { join } from "node:path";

// The folder talos keeps on this machine, like ~/.claude for Claude Code.
// TALOS_HOME moves it, so a second talos (like a test against a local server)
// doesn't share this one's key or session runner. Talos uses this export too,
// so the folder has one owner.
export const TALOS_HOME_ENV_KEY = "TALOS_HOME";
export const TALOS_FOLDER = process.env[TALOS_HOME_ENV_KEY] || join(homedir(), ".talos");
export const TALOS_FOLDER_MODE = 0o700;

// The session runner: the background program that holds the Claude Code
// terminals, so sessions outlive talos restarts. talos and the hook script
// reach it through file sockets only this user can open.
// Two sockets, so a session reaches only the hook one. The control socket
// (used by talos) carries the powerful routes - typing into sessions,
// starting/stopping them; the hook socket carries only hooks, which is all a
// running Claude session needs. Both are 0600 in the 0700 talos folder.
export const RUNNER_SOCKET = join(TALOS_FOLDER, "runner.sock");
export const RUNNER_HOOKS_SOCKET = join(TALOS_FOLDER, "runner-hooks.sock");
export const RUNNER_SOCKET_MODE = 0o600;
export const RUNNER_LOG = join(TALOS_FOLDER, "runner.log");
export const HOOK_SCRIPT = new URL("./hook.ts", import.meta.url).pathname;

// The MCP server with the structured tools (see tools-server.ts), passed to
// every session with --mcp-config. Its key is "talos", so Claude Code names a
// tool mcp__talos__<name>.
export const TOOLS_SERVER_SCRIPT = new URL("./tools-server.ts", import.meta.url).pathname;
export const TALOS_MCP_SERVER_KEY = "talos";
export const MCP_CONFIG_FILE = join(TALOS_FOLDER, "mcp-config.json");

// How often the session runner checks for asks that have timed out.
export const ASK_CHECK_MS = 5_000;
export const RUNNER_START_TIMEOUT_MS = 5000;
export const RUNNER_START_CHECK_MS = 100;

export const SESSION_ENV_KEYS = { sessionName: "TALOS_SESSION_NAME", runnerSocket: "TALOS_RUNNER_SOCKET", hookToken: "TALOS_HOOK_TOKEN" } as const;

export const CLAUDE_COMMAND = "claude";
export const CLAUDE_CONFIG_FILE = join(homedir(), ".claude.json");
export const TERMINAL_SIZE = { cols: 120, rows: 40 } as const;

// Claude Code is ready for typing once its screen has been still this long
// after it starts (see SESSION_LIMITS.readyLongestWaitMs for the longest wait).
export const READY_QUIET_MS = 1000;
export const READY_CHECK_MS = 200;

// How often the session runner looks for newly saved lines in each session's
// conversation, so the page sees Claude's work as it happens.
export const TRANSCRIPT_CHECK_MS = 300;
export const NEWLINE_BYTE = 0x0a;
// How much of a tool's input shows as its one-line summary; shorter than the
// most an entry may carry.
export const TOOL_SUMMARY_SHOWN_LENGTH = 300;

// Images sent from the page are saved here, one folder per session, and
// deleted when the session ends. Claude Code reads them from their path.
export const UPLOADS_FOLDER = join(TALOS_FOLDER, "uploads");
export const UPLOAD_FILE_MODE = 0o600;

// Claude Code takes a moment to load a pasted image; Enter pressed before
// that is lost, and the message with it.
export const IMAGE_PASTE_SETTLE_MS = 1000;
