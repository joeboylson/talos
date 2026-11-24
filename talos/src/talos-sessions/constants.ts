import { homedir } from "node:os";
import { join, resolve } from "node:path";

// The module's home: the folder it keeps its own files in, handed to it by the
// program using it (talos's is ~/.talos; an example's is its run/ folder). Only
// this user can open it.
export const HOME_MODE = 0o700;

// The session runner: the background program that holds the Claude Code
// sessions, so they outlive talos restarts. talos and each session's mod
// reach it through file sockets only this user can open.
// The control socket (used by talos) carries the powerful routes: sending into
// sessions, starting and stopping them. A session is told only the link
// socket. That's no wall: a session runs as the same user, so its Bash can
// open the control socket too (see MODULES.md's known limit). Both are 0600
// in the 0700 home.
export const RUNNER_SOCKET_MODE = 0o600;

// How often the session runner checks for asks that have timed out.
export const ASK_CHECK_MS = 5_000;
export const RUNNER_START_TIMEOUT_MS = 5000;
export const RUNNER_START_CHECK_MS = 100;

// The mod (see mod/): its source, and the one Claude Code version it's tested
// with, which every session runs (the pinned copy in the home) and which its
// manifest's engines range names.
export const MOD_FOLDER = new URL("./mod/", import.meta.url).pathname;
export const PINNED_CLAUDE_CODE_VERSION = "2.1.330";
// Where an installer keeps each version, when `claude` on the path is another.
export const CLAUDE_VERSIONS_FOLDER = join(homedir(), ".local", "share", "claude", "versions");
// Claude Code names a plugin loaded from a folder `<name>@inline`, and a
// mod's tool mcp__<name>__<tool>.
export const MOD_NAME = "talos";
export const MOD_PLUGIN_ID = `${MOD_NAME}@inline`;

export const CLAUDE_COMMAND = "claude";

// How much of a tool's input shows as its one-line summary; shorter than the
// most an entry may carry.
export const TOOL_SUMMARY_SHOWN_LENGTH = 300;


// Everything the module keeps in its home. A relative home is made whole
// first: sessions run in their own folders, where it would point somewhere else.
export const homePaths = (givenHome: string) => {
  const home = resolve(givenHome);
  return {
  home,
  runnerSocket: join(home, "runner.sock"),
  // Each session's mod reaches the runner here (see runner/link-server.ts).
  linkSocket: join(home, "runner-link.sock"),
  // Read-only copies of the mod, one folder per hash, and the pinned Claude Code.
  modSnapshots: join(home, "mod"),
  pinnedClaudeCode: join(home, "claude-code"),
  log: join(home, "runner.log"),
  quarantine: join(home, "quarantine.log"),
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
