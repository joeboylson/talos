import { join } from "node:path";
import { TALOS_FOLDER, TALOS_FOLDER_MODE } from "./talos-sessions";

export const CREDENTIALS_FOLDER = TALOS_FOLDER;
export const CREDENTIALS_FOLDER_MODE = TALOS_FOLDER_MODE;
export const CREDENTIALS_FILE = join(CREDENTIALS_FOLDER, "credentials.json");
export const FOLDERS_FILE = join(CREDENTIALS_FOLDER, "folders.json");

// Only this user can read the file: it holds the machine's key.
export const CREDENTIALS_FILE_MODE = 0o600;

// The session runner's start-up script, which talos spawns.
export const RUNNER_SCRIPT = new URL("./session-runner.ts", import.meta.url).pathname;

// Ctrl-\ leaves an attached session without stopping it.
export const DETACH_KEY = 0x1c;
