// The read-only copy of the mod that sessions load (see constants.ts MOD_FOLDER).
// Made when the runner starts, so an edit to the mod's source never reaches a
// running session, and named by its hash, which the mod's check-in carries.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ModFile = { path: string; content: Uint8Array };

// What isn't the mod itself: its tests, and the types Claude Code writes into
// a mod folder it loads for editing.
const LEFT_OUT = [/^tests\//, /^\.claude-plugin\/types\//, /^node_modules\//];
// Its files are read-only, so nothing edits one by accident; its folders
// aren't, so a home can still be deleted whole. (A session runs as the same
// user, so this is no lock.)
const READ_ONLY_FILE_MODE = 0o444;
const SNAPSHOTS_FOLDER_MODE = 0o700;
const MANIFEST_PATH = ".claude-plugin/plugin.json";

// The manifest with its engines range set to the one Claude Code version talos
// runs: outside it, Claude Code leaves the whole mod off.
export const withEngines = (manifestText: string, version: string): string =>
  `${JSON.stringify({ ...JSON.parse(manifestText), engines: { "claude-code": version } }, null, 2)}\n`;

export const prepareModFiles = (files: readonly ModFile[], version: string): ModFile[] =>
  files
    .filter(({ path }) => !LEFT_OUT.some((pattern) => pattern.test(path)))
    .map((file) => (file.path === MANIFEST_PATH ? { ...file, content: new TextEncoder().encode(withEngines(new TextDecoder().decode(file.content), version)) } : file))
    .toSorted((a, b) => a.path.localeCompare(b.path));

export const hashModFiles = (files: readonly ModFile[]): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  files.forEach(({ path, content }) => hasher.update(path).update("\0").update(content).update("\0"));
  return hasher.digest("hex").slice(0, 16);
};

const readModFiles = (modFolder: string): ModFile[] =>
  readdirSync(modFolder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const fullPath = join(entry.parentPath, entry.name);
      return { path: fullPath.slice(modFolder.length).replace(/^\//, ""), content: readFileSync(fullPath) };
    });

// Older snapshots go: no session outlives the runner that made them.
export const snapshotMod = (modFolder: string, snapshotsFolder: string, version: string): { folder: string; hash: string } => {
  const files = prepareModFiles(readModFiles(modFolder), version);
  const hash = hashModFiles(files);
  const folder = join(snapshotsFolder, hash);
  mkdirSync(snapshotsFolder, { recursive: true, mode: SNAPSHOTS_FOLDER_MODE });
  readdirSync(snapshotsFolder)
    .filter((name) => name !== hash)
    .forEach((name) => rmSync(join(snapshotsFolder, name), { recursive: true, force: true }));
  if (existsSync(folder)) return { folder, hash };
  const building = `${folder}.building`;
  // Built aside and renamed into place, so a half-written one is never loaded.
  rmSync(building, { recursive: true, force: true });
  files.forEach(({ path, content }) => {
    mkdirSync(dirname(join(building, path)), { recursive: true });
    writeFileSync(join(building, path), content, { mode: READ_ONLY_FILE_MODE });
  });
  renameSync(building, folder);
  return { folder, hash };
};
