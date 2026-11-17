import type { Folder } from "./messages";

export const MAX_FOLDERS = 200;

// A folder list, or null if this isn't one. Both sides read folder lists
// from outside (a file, a message), so neither trusts the shape.
export const readFolderList = (value: unknown): Folder[] | null => {
  if (!Array.isArray(value) || value.length > MAX_FOLDERS) return null;
  const isFolder = (item: unknown): item is Folder =>
    typeof item === "object" &&
    item !== null &&
    typeof Reflect.get(item, "folderName") === "string" &&
    typeof Reflect.get(item, "path") === "string";
  return value.every(isFolder) ? value.map(({ folderName, path }) => ({ folderName, path })) : null;
};
