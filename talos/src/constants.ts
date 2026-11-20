import { homedir } from "node:os";
import { join } from "node:path";

// The folder talos keeps on this machine, like ~/.claude for Claude Code. It's
// also talos-sessions' home, so the session runner's files sit beside talos's.
// TALOS_HOME moves it, so a second talos (like a test against a local server)
// doesn't share this one's key or session runner.
export const TALOS_FOLDER = process.env.TALOS_HOME || join(homedir(), ".talos");
export const CREDENTIALS_FOLDER = TALOS_FOLDER;
export const CREDENTIALS_FOLDER_MODE = 0o700;
export const CREDENTIALS_FILE = join(CREDENTIALS_FOLDER, "credentials.json");
export const FOLDERS_FILE = join(CREDENTIALS_FOLDER, "folders.json");

// Only this user can read the file: it holds the machine's key.
export const CREDENTIALS_FILE_MODE = 0o600;

// The session runner's start-up script, which talos spawns.
export const RUNNER_SCRIPT = new URL("./session-runner.ts", import.meta.url).pathname;

// Ctrl-\ leaves an attached session without stopping it.
export const DETACH_KEY = 0x1c;
