import { homedir } from "node:os";
import { join } from "node:path";

// TALOS_HOME moves everything talos keeps on this machine, so a second talos
// (like a test against a local server) doesn't share this one's key or host.
export const TALOS_HOME_ENV_KEY = "TALOS_HOME";
export const CREDENTIALS_FOLDER = process.env[TALOS_HOME_ENV_KEY] || join(homedir(), ".talos");
export const CREDENTIALS_FILE = join(CREDENTIALS_FOLDER, "credentials.json");
export const FOLDERS_FILE = join(CREDENTIALS_FOLDER, "folders.json");

// Only this user can read the file: it holds the machine's key.
export const CREDENTIALS_FILE_MODE = 0o600;
export const CREDENTIALS_FOLDER_MODE = 0o700;

// The session host: the background program that holds the Claude Code
// terminals, so sessions outlive talos restarts. talos and the hook script
// reach it through this file socket, which only this user can open.
// Two sockets, so a session reaches only the hook one. The control socket
// (used by talos) carries the powerful routes - typing into sessions,
// starting/stopping them; the hook socket carries only /hooks, which is all a
// running Claude session needs. Both are 0600 in the 0700 ~/.talos folder.
export const HOST_SOCKET = join(CREDENTIALS_FOLDER, "host.sock");
export const HOST_HOOKS_SOCKET = join(CREDENTIALS_FOLDER, "host-hooks.sock");
export const HOST_SOCKET_MODE = 0o600;
export const HOST_LOG = join(CREDENTIALS_FOLDER, "host.log");
export const HOST_SCRIPT = new URL("./host/entry.ts", import.meta.url).pathname;
export const HOOK_SCRIPT = new URL("./hook.ts", import.meta.url).pathname;

// The MCP server with talos's structured tools (see talos-tools.ts), passed to
// every session with --mcp-config. Its key is "talos", so Claude Code names a
// tool mcp__talos__<name>.
export const TALOS_TOOLS_SCRIPT = new URL("./talos-tools.ts", import.meta.url).pathname;
export const TALOS_MCP_SERVER_KEY = "talos";
export const MCP_CONFIG_FILE = join(CREDENTIALS_FOLDER, "mcp-config.json");

// How often the host checks for status requests that have timed out.
export const STATUS_CHECK_MS = 5_000;
export const HOST_START_TIMEOUT_MS = 5000;
export const HOST_START_CHECK_MS = 100;

export const SESSION_ENV_KEYS = { sessionName: "TALOS_SESSION_NAME", hostSocket: "TALOS_HOST_SOCKET", hookToken: "TALOS_HOOK_TOKEN" } as const;

// Every session shares one hooks socket, so a hook POST proves which session it
// is with this per-session token (minted at spawn, sent as a header). Without it
// a session could POST to another session's /hooks route and drive it.
export const HOOK_TOKEN_HEADER = "x-talos-hook-token";
export const HTTP_PAYLOAD_TOO_LARGE = 413;
export const CLAUDE_COMMAND = "claude";
export const CLAUDE_CONFIG_FILE = join(homedir(), ".claude.json");
export const TERMINAL_SIZE = { cols: 120, rows: 40 } as const;

// Claude Code is ready for typing once its screen has been still this long
// after it starts (see TALOS_LIMITS.readyLongestWaitMs for the longest wait).
export const READY_QUIET_MS = 1000;
export const READY_CHECK_MS = 200;

// How often the host looks for newly saved lines in each session's
// conversation, so the page sees Claude's work as it happens.
export const TRANSCRIPT_CHECK_MS = 300;
export const NEWLINE_BYTE = 0x0a;
// How much of a tool's input shows as its one-line summary; shorter than the
// most an entry may carry.
export const TOOL_SUMMARY_SHOWN_LENGTH = 300;

// Images sent from the page are saved here, one folder per session, and
// deleted when the session ends. Claude Code reads them from their path.
export const UPLOADS_FOLDER = join(CREDENTIALS_FOLDER, "uploads");
export const UPLOAD_FILE_MODE = 0o600;

// Claude Code takes a moment to load a pasted image; Enter pressed before
// that is lost, and the message with it.
export const IMAGE_PASTE_SETTLE_MS = 1000;

// Ctrl-\ leaves an attached session without stopping it.
export const DETACH_KEY = 0x1c;
