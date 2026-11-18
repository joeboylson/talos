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
export const HOST_SOCKET = join(CREDENTIALS_FOLDER, "host.sock");
export const HOST_LOG = join(CREDENTIALS_FOLDER, "host.log");
export const HOST_SCRIPT = new URL("./host.ts", import.meta.url).pathname;
export const HOOK_SCRIPT = new URL("./hook.ts", import.meta.url).pathname;
export const HOST_START_TIMEOUT_MS = 5000;
export const HOST_START_CHECK_MS = 100;

// The hook script must never hold Claude up.
export const HOOK_TIMEOUT_MS = 2000;

export const SESSION_ENV_KEYS = { sessionName: "TALOS_SESSION_NAME", hostSocket: "TALOS_HOST_SOCKET" } as const;
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
