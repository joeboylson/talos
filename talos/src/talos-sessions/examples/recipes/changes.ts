// Which files a run changed: its working copy against the data it started from.
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, relative, sep } from "node:path";

// Every file but git's own, by short path: a file by its bytes, a link by
// where it points (never followed). Folders aren't files.
const filesIn = (folder: string): Map<string, string> =>
  new Map(
    readdirSync(folder, { recursive: true, withFileTypes: true })
      .map((entry) => ({ entry, path: relative(folder, join(entry.parentPath, entry.name)) }))
      .filter(({ entry, path }) => (entry.isFile() || entry.isSymbolicLink()) && path.split(sep)[0] !== ".git")
      .map(({ entry, path }) => [path, entry.isSymbolicLink() ? `link to ${readlinkSync(join(folder, path))}` : readFileSync(join(folder, path)).toString("base64")] as const),
  );

// Added, removed or edited, by short path. Pure, given the two folders' files.
export const changedBetween = (before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] =>
  [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path) !== after.get(path)).sort();

export const changedFiles = (dataFolder: string, workFolder: string): string[] => changedBetween(filesIn(dataFolder), filesIn(workFolder));
