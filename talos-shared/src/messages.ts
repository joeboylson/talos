import { parseJsonOrNull } from "./json";

// machine-name: the owner renamed this machine on the page.
// rename-folder: the owner renamed one of its folders; the machine keeps its
// folders, so it makes the change and sends its new list.
export type ServerToMachine =
  | { type: "ping"; id: string }
  | { type: "machine-name"; machineName: string }
  | { type: "rename-folder"; folderName: string; newFolderName: string };
// A folder a machine allows sessions in. The name is its identifier part
// (talos:machines:work-mac:folders:<folderName>).
export type Folder = { folderName: string; path: string };

export type MachineToServer = { type: "pong"; id: string } | { type: "folders"; folders: Folder[] };

export type CurrentUserResponse = { displayName: string; isAdmin: boolean };
export type Settings = { allowNewPeople: boolean };
export type RenameRequest = { name: string };
export type MachineCheckResponse = { machineName: string };

// folders is null while the machine is offline: only the machine knows them.
export type MachineSummary = {
  machineId: string;
  machineName: string;
  isConnected: boolean;
  folders: Folder[] | null;
};

// Without a machineId, a ping goes to all of the person's connected machines.
export type PageToServer = { type: "ping"; machineId?: string };
export type ServerToPage =
  | { type: "machines"; machines: MachineSummary[] }
  | { type: "pong"; machineId: string; machineName: string; roundTripMs: number }
  | { type: "error"; message: string };

export type Message = ServerToMachine | MachineToServer | PageToServer | ServerToPage;

export const encode = <T extends Message>(message: T): string => JSON.stringify(message);

// Returns null for anything that isn't a JSON object with a string `type`;
// callers check `type` before trusting the rest.
export const decode = <T extends Message>(rawMessage: string | Buffer | ArrayBuffer): T | null => {
  const text = typeof rawMessage === "string" ? rawMessage : new TextDecoder().decode(rawMessage);
  const parsed: unknown = parseJsonOrNull(text);
  const isObject = typeof parsed === "object" && parsed !== null;
  const hasStringType = isObject && "type" in parsed && typeof parsed.type === "string";
  // The cast is the one unchecked step: fields beyond `type` are trusted.
  return hasStringType ? (parsed as T) : null;
};
