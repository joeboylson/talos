import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { ENV_KEYS, buildIdentifier, requireEnv } from "talos-shared";
import { cliError, formatTable, type Flags } from "./cli";
import type { FolderCommand } from "./commands";
import { readCredentials } from "./credentials";
import { addFolder, changeFolders, readFolders, removeFolder, renameFolder } from "./folders";

// "~/code/x" and "./x" both become full paths, so a folder means the same
// thing however it was typed.
export const resolveFolderPath = (typedPath: string, currentFolder: string, homeFolder: string): string =>
  resolve(currentFolder, typedPath.replace(/^~(?=$|\/)/, homeFolder));

// The folder as the disk names it, or null if it isn't one. macOS folds case
// and accent forms, so "Proj" and "proj" (or two spellings of "café") are one
// folder, and only its real path tells them apart from two.
export const realFolderPath = async (path: string): Promise<string | null> => {
  const isDirectory = await stat(path).then((pathInfo) => pathInfo.isDirectory(), () => false);
  return isDirectory ? realpath(path) : null;
};

// The folder's full identifier once this machine knows its name; before it's
// paired, just the folder's own name.
const describeFolder = async (folderName: string): Promise<string> => {
  const credentials = await readCredentials(requireEnv(ENV_KEYS.serverUrl));
  if (!credentials?.machineName) return folderName;
  return buildIdentifier(["machines", credentials.machineName, "folders", folderName]);
};

const changeOrFail = async (change: Awaited<ReturnType<typeof changeFolders>>) => {
  if ("problem" in change) throw cliError(change.problem, "talos folders");
  return change.folder;
};

// Folders belong to the machine these commands run on. They're kept on the
// machine itself, so nothing else can change them.
export const runFolderCommand = async (command: FolderCommand, flags: Flags): Promise<void> => {
  if (command.name === "folders-list") {
    const folders = await readFolders();
    if (flags.json) return console.log(JSON.stringify(folders, null, 2));
    if (folders.length === 0) return console.error("talos: no folders yet (talos folders add <path>)");
    return console.log(formatTable(["folder", "path"], folders.map(({ folderName, path }) => [folderName, path]), process.stdout.isTTY === true));
  }

  if (command.name === "folders-add") {
    const typedPath = resolveFolderPath(command.path, process.cwd(), homedir());
    const absolutePath = await realFolderPath(typedPath);
    if (!absolutePath) throw cliError(`${typedPath} isn't a folder`);
    const folder = await changeOrFail(await changeFolders((folders) => addFolder(folders, absolutePath)));
    return console.log(`added ${await describeFolder(folder.folderName)}`);
  }

  if (command.name === "folders-rename") {
    const folder = await changeOrFail(await changeFolders((folders) => renameFolder(folders, command.folderName, command.newName)));
    return console.log(`renamed to ${await describeFolder(folder.folderName)}`);
  }

  const folder = await changeOrFail(await changeFolders((folders) => removeFolder(folders, command.folderName)));
  console.log(`removed ${await describeFolder(folder.folderName)}`);
};
