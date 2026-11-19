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
export const HOST_SCRIPT = new URL("./host.ts", import.meta.url).pathname;
export const HOOK_SCRIPT = new URL("./hook.ts", import.meta.url).pathname;

// The report_status MCP server (see status-tool.ts), passed to every session
// with --mcp-config. The server key is "talosstatus", so Claude Code names the
// tool mcp__talosstatus__report_status.
export const STATUS_TOOL_SCRIPT = new URL("./status-tool.ts", import.meta.url).pathname;
export const STATUS_MCP_SERVER_KEY = "talosstatus";
export const STATUS_TOOL_BARE_NAME = "report_status";
export const STATUS_TOOL_NAME = `mcp__${STATUS_MCP_SERVER_KEY}__${STATUS_TOOL_BARE_NAME}`;
export const MCP_CONFIG_FILE = join(CREDENTIALS_FOLDER, "mcp-config.json");

// A status request that goes unanswered this long becomes "no response".
export const STATUS_TIMEOUT_MS = 60_000;
// An ask queued behind a busy session waits this long for it to go idle: long
// enough for real work, short enough that a session stuck waiting on the person
// doesn't block asks for good.
export const QUEUED_STATUS_TIMEOUT_MS = 30 * 60_000;
// How often the host checks for status requests that have timed out.
export const STATUS_CHECK_MS = 5_000;
export const HOST_START_TIMEOUT_MS = 5000;
export const HOST_START_CHECK_MS = 100;

// The hook script must never hold Claude up.
export const HOOK_TIMEOUT_MS = 2000;

export const SESSION_ENV_KEYS = { sessionName: "TALOS_SESSION_NAME", hostSocket: "TALOS_HOST_SOCKET", hookToken: "TALOS_HOOK_TOKEN" } as const;

// Every session shares one hooks socket, so a hook POST proves which session it
// is with this per-session token (minted at spawn, sent as a header). Without it
// a session could POST to another session's /hooks route and drive it.
export const HOOK_TOKEN_HEADER = "x-talos-hook-token";
export const CLAUDE_COMMAND = "claude";
export const CLAUDE_CONFIG_FILE = join(homedir(), ".claude.json");
export const TERMINAL_SIZE = { cols: 120, rows: 40 } as const;

// Enough recent output to redraw Claude Code's screen for someone attaching.
export const MAX_OUTPUT_BYTES = 256 * 1024;

// Claude Code is ready for typing once its screen has been still this long
// after it starts; past the longest wait, talos types anyway.
export const READY_QUIET_MS = 1000;
export const READY_LONGEST_WAIT_MS = 15_000;
export const READY_CHECK_MS = 200;

// How often the host looks for newly saved lines in each session's
// conversation, so the page sees Claude's work as it happens.
export const TRANSCRIPT_CHECK_MS = 300;
export const NEWLINE_BYTE = 0x0a;
// Most a single transcript poll reads and parses at once, so one session's large
// transcript is drained over several polls instead of blocking the host in one go.
export const MAX_TRANSCRIPT_READ_BYTES = 4 * 1024 * 1024;
// Rapid session state/status changes collapse into one roster broadcast per this
// window, so a session flapping its state can't flood the host→server uplink.
export const SESSIONS_BROADCAST_COALESCE_MS = 100;
// A hook POST body is parsed synchronously on the host's one thread, so cap it:
// a session can't send a huge body that JSON.parse blocks on for seconds (which
// would make every other session's hook time out and fail open). Real hook bodies
// are small; this leaves generous room for a large tool input.
export const HOOK_MAX_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_TOOL_SUMMARY_LENGTH = 300;
export const MAX_TOOL_NAME_LENGTH = 100;

// Images sent from the page are saved here, one folder per session, and
// deleted when the session ends. Claude Code reads them from their path.
export const UPLOADS_FOLDER = join(CREDENTIALS_FOLDER, "uploads");
export const UPLOAD_FILE_MODE = 0o600;

// Claude Code takes a moment to load a pasted image; Enter pressed before
// that is lost, and the message with it.
export const IMAGE_PASTE_SETTLE_MS = 1000;

// Ctrl-\ leaves an attached session without stopping it.
export const DETACH_KEY = 0x1c;
