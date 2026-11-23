import { homedir } from "node:os";
import { join, resolve } from "node:path";

// The module's home: the folder it keeps its own files in, handed to it by the
// program using it (talos's is ~/.talos; an example's is its run/ folder). Only
// this user can open it.
export const HOME_MODE = 0o700;

// The session runner: the background program that holds the Claude Code
// terminals, so sessions outlive talos restarts. talos and the hook script
// reach it through file sockets only this user can open.
// The control socket (used by talos) carries the powerful routes: typing into
// sessions, starting and stopping them. A session is told only the hooks and
// link sockets. That's no wall: a session runs as the same user, so its Bash
// can open the control socket too (see MODULES.md's known limit). All are
// 0600 in the 0700 home.
export const RUNNER_SOCKET_MODE = 0o600;
export const HOOK_SCRIPT = new URL("./hook.ts", import.meta.url).pathname;

// The MCP server with the structured tools (see tools-server.ts), passed to
// every session with --mcp-config. Its key is "talos", so Claude Code names a
// tool mcp__talos__<name>.
export const TOOLS_SERVER_SCRIPT = new URL("./tools-server.ts", import.meta.url).pathname;
export const TALOS_MCP_SERVER_KEY = "talos";

// How often the session runner checks for asks that have timed out.
export const ASK_CHECK_MS = 5_000;
export const RUNNER_START_TIMEOUT_MS = 5000;
export const RUNNER_START_CHECK_MS = 100;

export const SESSION_ENV_KEYS = { sessionName: "TALOS_SESSION_NAME", runnerSocket: "TALOS_RUNNER_SOCKET", hookToken: "TALOS_HOOK_TOKEN" } as const;

// The mod (see mod/): its source, and the one Claude Code version it's tested
// with, which every session runs (the pinned copy in the home) and which its
// manifest's engines range names.
export const MOD_FOLDER = new URL("./mod/", import.meta.url).pathname;
export const PINNED_CLAUDE_CODE_VERSION = "2.1.330";
// Where an installer keeps each version, when `claude` on the path is another.
export const CLAUDE_VERSIONS_FOLDER = join(homedir(), ".local", "share", "claude", "versions");
// Claude Code names a plugin loaded from a folder `<name>@inline`.
export const MOD_PLUGIN_ID = "talos@inline";

export const CLAUDE_COMMAND = "claude";
export const CLAUDE_CONFIG_FILE = join(homedir(), ".claude.json");
export const TERMINAL_SIZE = { cols: 120, rows: 40 } as const;


// How often the session runner looks for newly saved lines in each session's
// conversation, so the page sees Claude's work as it happens.
export const TRANSCRIPT_CHECK_MS = 300;
export const NEWLINE_BYTE = 0x0a;
// How much of a tool's input shows as its one-line summary; shorter than the
// most an entry may carry.
export const TOOL_SUMMARY_SHOWN_LENGTH = 300;

export const UPLOAD_FILE_MODE = 0o600;

// Everything the module keeps in its home. Images sent with a message go in
// uploads/, one folder per session, which keeps the newest 20 and goes when
// the session ends; Claude Code reads them from their path. A relative home is made whole first: sessions
// run in their own folders, where it would point somewhere else.
export const homePaths = (givenHome: string) => {
  const home = resolve(givenHome);
  return {
  home,
  runnerSocket: join(home, "runner.sock"),
  hooksSocket: join(home, "runner-hooks.sock"),
  // Each session's mod reaches the runner here (see runner/link-server.ts).
  linkSocket: join(home, "runner-link.sock"),
  // Read-only copies of the mod, one folder per hash, and the pinned Claude Code.
  modSnapshots: join(home, "mod"),
  pinnedClaudeCode: join(home, "claude-code"),
  log: join(home, "runner.log"),
  mcpConfig: join(home, "mcp-config.json"),
  uploads: join(home, "uploads"),
  quarantine: join(home, "quarantine.log"),
  // The trust answers to put back, kept on disk so a runner that crashed or was
  // killed puts them back when the next one starts.
  trustChanges: join(home, "trust-changes.json"),
  // The process group of each session's Claude, so a runner that dies outright
  // leaves the next one able to end what its sessions started.
  sessionGroups: join(home, "session-groups.json"),
  // The live runner's process id: only one runner may hold a home.
  runnerLock: join(home, "runner.lock"),
  };
};
export type HomePaths = ReturnType<typeof homePaths>;

// The time for every wait and order the runner keeps in memory (times saved to
// disk use the wall clock, since another process reads them): like Date.now() when the
// runner starts, but it only moves forward, so the system clock jumping back
// (or a person changing it) can't stretch a wait or reorder what was asked.
export const steadyNow = (): number => performance.timeOrigin + performance.now();
