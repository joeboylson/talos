import { rm, stat, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { LIMITS, parseJsonOrNull, pickUniqueName, readFolderList, toIdentifierName, type Folder } from "talos-shared";
import { FOLDERS_FILE } from "./constants";
import { claimTalosFolder, writePrivately } from "./talos-folder";

export type FolderChange = { folders: Folder[]; folder: Folder } | { problem: string };

// Adding the same path twice keeps the first entry. A new folder's name
// comes from the folder itself ("/home/joe/My Project" → "my-project"),
// made unique among this machine's folders.
export const addFolder = (folders: Folder[], absolutePath: string): FolderChange => {
  const existingFolder = folders.find((folder) => folder.path === absolutePath);
  if (existingFolder) return { problem: `${absolutePath} is already a folder here (${existingFolder.folderName})` };
  if (folders.length >= LIMITS.maxFolders) return { problem: `this machine already has ${LIMITS.maxFolders} folders` };

  const takenNames = folders.map((folder) => folder.folderName);
  const folderName = pickUniqueName(toIdentifierName(basename(absolutePath)), takenNames);
  const folder = { folderName, path: absolutePath };
  return { folders: [...folders, folder], folder };
};

export const removeFolder = (folders: Folder[], folderName: string): FolderChange => {
  const folder = folders.find((candidate) => candidate.folderName === folderName);
  if (!folder) return { problem: `this machine has no folder called ${folderName}` };
  return { folders: folders.filter((candidate) => candidate !== folder), folder };
};

// Only the name changes; the path stays. The new name is cleaned up and made
// unique among this machine's other folders.
export const renameFolder = (folders: Folder[], folderName: string, typedName: string): FolderChange => {
  const folder = folders.find((candidate) => candidate.folderName === folderName);
  if (!folder) return { problem: `this machine has no folder called ${folderName}` };
  const otherNames = folders.filter((candidate) => candidate !== folder).map((candidate) => candidate.folderName);
  const renamedFolder = { ...folder, folderName: pickUniqueName(toIdentifierName(typedName), otherNames) };
  return { folders: folders.map((candidate) => (candidate === folder ? renamedFolder : candidate)), folder: renamedFolder };
};

// No file yet means no folders. A file talos can't read fails loudly rather
// than quietly dropping the folders in it.
export const readFolders = async (): Promise<Folder[]> => {
  const foldersFile = Bun.file(FOLDERS_FILE);
  if (!(await foldersFile.exists())) return [];
  const folders = readFolderList(parseJsonOrNull(await foldersFile.text()));
  if (!folders) throw new Error(`${FOLDERS_FILE} isn't a folder list; fix or delete it`);
  return folders;
};

// Private and swapped in whole, so a reader never sees half a list.
const saveFolders = (folders: Folder[]): Promise<void> => writePrivately(FOLDERS_FILE, JSON.stringify(folders, null, 2));

// One change to the list at a time across every talos process on the machine
// (two `talos folders add` at once, or one beside a page's rename), so none
// is lost. A lock left by a process that died is taken over after a while.
const FOLDERS_LOCK = `${FOLDERS_FILE}.lock`;
const LOCK_STALE_MS = 10_000;
const LOCK_TRY_EVERY_MS = 20;
const takeFoldersLock = async (): Promise<void> => {
  await claimTalosFolder();
  while (true) {
    try {
      return await writeFile(FOLDERS_LOCK, String(process.pid), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = await stat(FOLDERS_LOCK).then(({ mtimeMs }) => Date.now() - mtimeMs, () => 0);
      // A file's time can be a little ahead of the clock, so only far off counts.
      if (Math.abs(age) > LOCK_STALE_MS) await rm(FOLDERS_LOCK, { force: true });
      else await Bun.sleep(LOCK_TRY_EVERY_MS);
    }
  }
};

// Reads the list, makes one change, and saves it if the change worked.
export const changeFolders = async (change: (folders: Folder[]) => FolderChange): Promise<FolderChange> => {
  await takeFoldersLock();
  try {
    const changed = change(await readFolders());
    if (!("problem" in changed)) await saveFolders(changed.folders);
    return changed;
  } finally {
    await rm(FOLDERS_LOCK, { force: true });
  }
};
