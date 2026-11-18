import { readFolderList } from "./folders";
import { isIdentifierName } from "./identifiers";
import type { MachineToServer, PageToServer, ServerToMachine } from "./messages";
import { MAX_ENTRY_TEXT_LENGTH, readSentImages, readSessionEntries, readSessionList } from "./sessions";

// Every message is read field by field before anything acts on it. A message
// that's wrong in any way is dropped whole: one bad field must never crash a
// side or slip through as the wrong type.

const MAX_ID_LENGTH = 200;
const MAX_TYPED_NAME_LENGTH = 100;

const fieldOf = (message: object, field: string): unknown => Reflect.get(message, field);

const isShortText = (value: unknown, maxLength: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maxLength;

const readText = (value: unknown): string | null =>
  typeof value === "string" && value.length <= MAX_ENTRY_TEXT_LENGTH ? value : null;

const typeOf = (value: unknown): { message: object; type: unknown } | null =>
  typeof value === "object" && value !== null ? { message: value, type: fieldOf(value, "type") } : null;

export const readPageToServer = (value: unknown): PageToServer | null => {
  const read = typeOf(value);
  if (!read) return null;
  const { message, type } = read;
  const machineId = fieldOf(message, "machineId");
  if (type === "ping") {
    if (machineId === undefined) return { type };
    return isShortText(machineId, MAX_ID_LENGTH) ? { type, machineId } : null;
  }
  if (!isShortText(machineId, MAX_ID_LENGTH)) return null;

  if (type === "start-session") {
    const folderName = fieldOf(message, "folderName");
    const sessionName = fieldOf(message, "sessionName");
    if (!isIdentifierName(folderName)) return null;
    if (sessionName === undefined) return { type, machineId, folderName };
    return typeof sessionName === "string" && sessionName.length <= MAX_TYPED_NAME_LENGTH
      ? { type, machineId, folderName, sessionName }
      : null;
  }

  const sessionName = fieldOf(message, "sessionName");
  if (!isIdentifierName(sessionName)) return null;
  if (type === "stop-session") return { type, machineId, sessionName };
  if (type !== "send-to-session") return null;
  const text = readText(fieldOf(message, "text"));
  const images = readSentImages(fieldOf(message, "images"));
  return text !== null && images ? { type, machineId, sessionName, text, images } : null;
};

export const readServerToMachine = (value: unknown): ServerToMachine | null => {
  const read = typeOf(value);
  if (!read) return null;
  const { message, type } = read;

  if (type === "ping") {
    const id = fieldOf(message, "id");
    return isShortText(id, MAX_ID_LENGTH) ? { type, id } : null;
  }
  if (type === "machine-name") {
    const machineName = fieldOf(message, "machineName");
    return isIdentifierName(machineName) ? { type, machineName } : null;
  }
  if (type === "rename-folder") {
    const folderName = fieldOf(message, "folderName");
    const newFolderName = fieldOf(message, "newFolderName");
    const isRename = isIdentifierName(folderName) && isShortText(newFolderName, MAX_TYPED_NAME_LENGTH);
    return isRename ? { type, folderName, newFolderName } : null;
  }

  const sessionName = fieldOf(message, "sessionName");
  if (!isIdentifierName(sessionName)) return null;
  if (type === "stop-session") return { type, sessionName };
  if (type === "start-session") {
    const folderName = fieldOf(message, "folderName");
    return isIdentifierName(folderName) ? { type, folderName, sessionName } : null;
  }
  if (type !== "send-to-session") return null;
  const text = readText(fieldOf(message, "text"));
  const images = readSentImages(fieldOf(message, "images"));
  return text !== null && images ? { type, sessionName, text, images } : null;
};

export const readMachineToServer = (value: unknown): MachineToServer | null => {
  const read = typeOf(value);
  if (!read) return null;
  const { message, type } = read;

  if (type === "pong") {
    const id = fieldOf(message, "id");
    return isShortText(id, MAX_ID_LENGTH) ? { type, id } : null;
  }
  if (type === "folders") {
    const folders = readFolderList(fieldOf(message, "folders"));
    return folders ? { type, folders } : null;
  }
  if (type === "sessions") {
    const sessions = readSessionList(fieldOf(message, "sessions"));
    return sessions ? { type, sessions } : null;
  }
  if (type !== "session-entries") return null;
  const sessionName = fieldOf(message, "sessionName");
  const entries = readSessionEntries(fieldOf(message, "entries"));
  return isIdentifierName(sessionName) && entries ? { type, sessionName, entries } : null;
};
