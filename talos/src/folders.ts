import { mkdir } from "node:fs/promises";
import { basename } from "node:path";
import {
  MAX_FOLDERS,
  parseJsonOrNull,
  pickUniqueName,
  readFolderList,
  toIdentifierName,
  type Folder,
} from "talos-shared";
import { CREDENTIALS_FOLDER, CREDENTIALS_FOLDER_MODE, FOLDERS_FILE } from "./constants";

type FolderChange = { folders: Folder[]; folder: Folder } | { problem: string };

// Adding the same path twice keeps the first entry. A new folder's name
// comes from the folder itself ("/home/joe/My Project" → "my-project"),
// made unique among this machine's folders.
export const addFolder = (folders: Folder[], absolutePath: string): FolderChange => {
  const existingFolder = folders.find((folder) => folder.path === absolutePath);
  if (existingFolder) return { problem: `${absolutePath} is already a folder here (${existingFolder.folderName})` };
  if (folders.length >= MAX_FOLDERS) return { problem: `this machine already has ${MAX_FOLDERS} folders` };

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

export const saveFolders = async (folders: Folder[]): Promise<void> => {
  await mkdir(CREDENTIALS_FOLDER, { recursive: true, mode: CREDENTIALS_FOLDER_MODE });
  await Bun.write(FOLDERS_FILE, JSON.stringify(folders, null, 2));
};
