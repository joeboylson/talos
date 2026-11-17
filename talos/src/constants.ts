import { homedir } from "node:os";
import { join } from "node:path";

export const CREDENTIALS_FOLDER = join(homedir(), ".talos");
export const CREDENTIALS_FILE = join(CREDENTIALS_FOLDER, "credentials.json");
export const FOLDERS_FILE = join(CREDENTIALS_FOLDER, "folders.json");

// Only this user can read the file: it holds the machine's key.
export const CREDENTIALS_FILE_MODE = 0o600;
export const CREDENTIALS_FOLDER_MODE = 0o700;
