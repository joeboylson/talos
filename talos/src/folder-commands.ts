import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { ENV_KEYS, buildIdentifier, requireEnv } from "talos-shared";
import type { Command } from "./commands";
import { readCredentials } from "./credentials";
import { addFolder, readFolders, removeFolder, renameFolder, saveFolders } from "./folders";

type FolderCommand = Extract<Command, { name: "folders-list" | "folders-add" | "folders-remove" | "folders-rename" }>;

// "~/code/x" and "./x" both become full paths, so a folder means the same
// thing however it was typed.
export const resolveFolderPath = (typedPath: string, currentFolder: string, homeFolder: string): string =>
  resolve(currentFolder, typedPath.replace(/^~(?=$|\/)/, homeFolder));

const isFolder = (path: string): Promise<boolean> =>
  stat(path).then(
    (pathInfo) => pathInfo.isDirectory(),
    () => false,
  );

const fail = (problem: string): never => {
  console.error(`talos: ${problem}`);
  process.exit(1);
};

// The folder's full identifier once this machine knows its name; before it's
// paired, just the folder's own name.
const describeFolder = async (folderName: string): Promise<string> => {
  const credentials = await readCredentials(requireEnv(ENV_KEYS.serverUrl));
  if (!credentials?.machineName) return folderName;
  return buildIdentifier(["machines", credentials.machineName, "folders", folderName]);
};

// Folders belong to the machine these commands run on. They're kept on the
// machine itself, so nothing else can change them.
export const runFolderCommand = async (command: FolderCommand): Promise<void> => {
  const folders = await readFolders();

  if (command.name === "folders-list") {
    if (folders.length === 0) return console.log("no folders");
    folders.forEach(({ folderName, path }) => console.log(`${folderName}\t${path}`));
    return;
  }

  if (command.name === "folders-add") {
    const absolutePath = resolveFolderPath(command.path, process.cwd(), homedir());
    if (!(await isFolder(absolutePath))) return fail(`${absolutePath} isn't a folder`);
    const change = addFolder(folders, absolutePath);
    if ("problem" in change) return fail(change.problem);
    await saveFolders(change.folders);
    return console.log(await describeFolder(change.folder.folderName));
  }

  if (command.name === "folders-rename") {
    const change = renameFolder(folders, command.folderName, command.newName);
    if ("problem" in change) return fail(change.problem);
    await saveFolders(change.folders);
    return console.log(await describeFolder(change.folder.folderName));
  }

  const change = removeFolder(folders, command.folderName);
  if ("problem" in change) return fail(change.problem);
  await saveFolders(change.folders);
  console.log(`removed ${await describeFolder(change.folder.folderName)}`);
};
