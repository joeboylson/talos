import { readFolderList } from "./folders";
import { isIdentifierName } from "./identifiers";
import type { MachineToServer, PageToServer, ServerToMachine } from "./messages";
import { readSentImages, readSessionEntries, readSessionList } from "./sessions";
import { LIMITS } from "./limits";

// Every message is read field by field before anything acts on it. A message
// that's wrong in any way is dropped whole: one bad field must never crash a
// side or slip through as the wrong type.


const fieldOf = (message: object, field: string): unknown => Reflect.get(message, field);

const isShortText = (value: unknown, maxLength: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maxLength;

const readText = (value: unknown): string | null =>
  typeof value === "string" && value.length <= LIMITS.maxSentTextLength ? value : null;

// An answer to an output names it by id and picks a choice by its position.
const readAnswer = (message: object): { outputId: string; choice: number } | null => {
  const outputId = fieldOf(message, "outputId");
  const choice = fieldOf(message, "choice");
  const isChoice = Number.isInteger(choice) && Number(choice) >= 0 && Number(choice) < LIMITS.maxDecisionChoices;
  return isShortText(outputId, LIMITS.maxIdTextLength) && isChoice ? { outputId, choice: Number(choice) } : null;
};

const typeOf = (value: unknown): { message: object; type: unknown } | null =>
  typeof value === "object" && value !== null ? { message: value, type: fieldOf(value, "type") } : null;

export const readPageToServer = (value: unknown): PageToServer | null => {
  const read = typeOf(value);
  if (!read) return null;
  const { message, type } = read;
  const machineId = fieldOf(message, "machineId");
  if (type === "ping") {
    if (machineId === undefined) return { type };
    return isShortText(machineId, LIMITS.maxIdTextLength) ? { type, machineId } : null;
  }
  if (!isShortText(machineId, LIMITS.maxIdTextLength)) return null;

  if (type === "start-session") {
    const folderName = fieldOf(message, "folderName");
    const sessionName = fieldOf(message, "sessionName");
    if (!isIdentifierName(folderName)) return null;
    if (sessionName === undefined) return { type, machineId, folderName };
    return typeof sessionName === "string" && sessionName.length <= LIMITS.maxNameTextLength
      ? { type, machineId, folderName, sessionName }
      : null;
  }

  const sessionName = fieldOf(message, "sessionName");
  if (!isIdentifierName(sessionName)) return null;
  if (type === "stop-session") return { type, machineId, sessionName };
  if (type === "ask-for-output") {
    const kind = fieldOf(message, "kind");
    return isShortText(kind, LIMITS.maxNameTextLength) ? { type, machineId, sessionName, kind } : null;
  }
  if (type === "answer-output") {
    const answer = readAnswer(message);
    return answer ? { type, machineId, sessionName, ...answer } : null;
  }
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
    return isShortText(id, LIMITS.maxIdTextLength) ? { type, id } : null;
  }
  if (type === "machine-name") {
    const machineName = fieldOf(message, "machineName");
    return isIdentifierName(machineName) ? { type, machineName } : null;
  }
  if (type === "rename-folder") {
    const folderName = fieldOf(message, "folderName");
    const newFolderName = fieldOf(message, "newFolderName");
    const isRename = isIdentifierName(folderName) && isShortText(newFolderName, LIMITS.maxNameTextLength);
    return isRename ? { type, folderName, newFolderName } : null;
  }

  const sessionName = fieldOf(message, "sessionName");
  if (!isIdentifierName(sessionName)) return null;
  if (type === "stop-session") return { type, sessionName };
  if (type === "ask-for-output") {
    const kind = fieldOf(message, "kind");
    return isShortText(kind, LIMITS.maxNameTextLength) ? { type, sessionName, kind } : null;
  }
  if (type === "answer-output") {
    const answer = readAnswer(message);
    return answer ? { type, sessionName, ...answer } : null;
  }
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
    return isShortText(id, LIMITS.maxIdTextLength) ? { type, id } : null;
  }
  if (type === "error") {
    const text = fieldOf(message, "message");
    return isShortText(text, LIMITS.maxMachineErrorLength) ? { type, message: text } : null;
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
