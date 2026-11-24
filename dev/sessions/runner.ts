// The live checks' session runner: talos's own kinds and folder check, but it
// puts back the trust it gave its throwaway folders when it stops.
import { readFolders } from "../../talos/src/folders";
import { OUTPUT_KINDS, PROSE_TURN } from "../../talos/src/session-outputs";
import { runSessionRunner } from "../../talos/src/talos-sessions";

const home = process.argv[2];
if (!home) throw new Error("runner.ts needs its home folder as its argument");

await runSessionRunner({
  home,
  log: { event: console.log, detail: () => {}, warn: console.warn },
  isAllowedFolder: async (folderName, path) => (await readFolders()).some((folder) => folder.folderName === folderName && folder.path === path),
  kinds: OUTPUT_KINDS,
  proseTurn: PROSE_TURN,
});
