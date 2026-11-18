import { isIdentifierName } from "./identifiers";
import type { Folder } from "./messages";

export const MAX_FOLDERS = 200;
const MAX_PATH_LENGTH = 4096;

// A folder list, or null if this isn't one. Both sides read folder lists
// from outside (a file, a message), so neither trusts the shape.
export const readFolderList = (value: unknown): Folder[] | null => {
  if (!Array.isArray(value) || value.length > MAX_FOLDERS) return null;
  const isFolder = (item: unknown): item is Folder =>
    typeof item === "object" &&
    item !== null &&
    isIdentifierName(Reflect.get(item, "folderName")) &&
    typeof Reflect.get(item, "path") === "string" &&
    String(Reflect.get(item, "path")).length <= MAX_PATH_LENGTH;
  return value.every(isFolder) ? value.map(({ folderName, path }) => ({ folderName, path })) : null;
};
