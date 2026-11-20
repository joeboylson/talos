// Which files a run changed: its working copy against the data it started from.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const filesIn = (folder: string): Map<string, string> =>
  new Map(
    readdirSync(folder, { recursive: true, encoding: "utf8" })
      .filter((path) => path.endsWith(".md"))
      .map((path) => [path, readFileSync(join(folder, path), "utf8")] as const),
  );

// Added, removed or edited, by short path. Pure, given the two folders' files.
export const changedBetween = (before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] =>
  [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path) !== after.get(path)).sort();

export const changedFiles = (dataFolder: string, workFolder: string): string[] => changedBetween(filesIn(dataFolder), filesIn(workFolder));
