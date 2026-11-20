// The session runner's start-up: talos spawns this file as its own background
// program (see RUNNER_SCRIPT). Talos's checks run inside it, since a check
// can't cross from one process to another.
import { ENV_KEYS, createLogger, readLogsMode } from "talos-shared";
import { readFolders } from "./folders";
import { runSessionRunner } from "./talos-sessions";

await runSessionRunner({
  log: createLogger(readLogsMode(process.env[ENV_KEYS.logsMode])),
  // Read fresh on every start, so a folder added or removed counts at once.
  isAllowedFolder: async (folderName, path) =>
    (await readFolders()).some((folder) => folder.folderName === folderName && folder.path === path),
});
