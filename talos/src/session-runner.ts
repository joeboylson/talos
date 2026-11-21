// The session runner's start-up: talos spawns this file as its own background
// program (see RUNNER_SCRIPT), with its home as the argument. Talos's checks
// run inside it, since a check can't cross from one process to another.
import { ENV_KEYS, createLogger, readLogsMode } from "talos-shared";
import { readFolders } from "./folders";
import { OUTPUT_KINDS, PROSE_TURN } from "./session-outputs";
import { runSessionRunner } from "./talos-sessions";

const home = process.argv[2];
if (!home) throw new Error("session-runner.ts needs its home folder as its argument");

await runSessionRunner({
  home,
  log: createLogger(readLogsMode(process.env[ENV_KEYS.logsMode])),
  // Read fresh on every start, so a folder added or removed counts at once.
  isAllowedFolder: async (folderName, path) =>
    (await readFolders()).some((folder) => folder.folderName === folderName && folder.path === path),
  kinds: OUTPUT_KINDS,
  proseTurn: PROSE_TURN,
});
