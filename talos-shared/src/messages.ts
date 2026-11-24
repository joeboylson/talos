import { parseJsonOrNull } from "./json";
import type { SentImage, SessionEntry, SessionSummary } from "./sessions";

// A folder a machine allows sessions in. The name is its identifier part
// (talos:machines:work-mac:folders:<folderName>).
export type Folder = { folderName: string; path: string };

// machine-name: the owner renamed this machine on the page.
// rename-folder: the owner renamed one of its folders; the machine keeps its
// folders, so it makes the change and sends its new list.
// start-, send-to-, interrupt- and stop-session: the owner, from the page.
// interrupt-session stops a session's running turn; the session goes on.
// answer-permission answers a permission prompt showing in its terminal.
// requestId: names the page's request a command came from, so what didn't
// happen is shown on that page only. The server makes its own for the machine.
type Request = { requestId?: string };

export type ServerToMachine =
  | { type: "ping"; id: string }
  | { type: "machine-name"; machineName: string }
  | { type: "rename-folder"; folderName: string; newFolderName: string }
  | ({ type: "start-session"; folderName: string; sessionName: string } & Request)
  | ({ type: "send-to-session"; sessionName: string; text: string; images: SentImage[] } & Request)
  | ({ type: "ask-for-output"; sessionName: string; kind: string } & Request)
  | ({ type: "answer-output"; sessionName: string; outputId: string; choice: number } & Request)
  | ({ type: "answer-permission"; sessionName: string; toolUseId: string; isAllowed: boolean } & Request)
  | ({ type: "interrupt-session"; sessionName: string } & Request)
  | ({ type: "stop-session"; sessionName: string } & Request);

// error: something the owner asked for didn't happen, like an answer to a
// question that has closed. The server shows it on the owner's pages.
// message-returned: a message that waited for its turn and won't go in (an
// interrupt, Esc in its terminal), back to the page that sent it.
export type MachineToServer =
  | { type: "pong"; id: string }
  | ({ type: "error"; message: string } & Request)
  | ({ type: "message-returned"; sessionName: string; text: string } & Request)
  | { type: "folders"; folders: Folder[] }
  | { type: "sessions"; sessions: SessionSummary[] }
  | { type: "session-entries"; sessionName: string; entries: SessionEntry[] };

export type CurrentUserResponse = { displayName: string; isAdmin: boolean };
export type Settings = { allowNewPeople: boolean };
export type RenameRequest = { name: string };
export type MachineCheckResponse = { machineName: string };

// folders and sessions are what the machine last reported, kept while it's
// offline; null when it hasn't reported since the server started.
export type MachineSummary = {
  machineId: string;
  machineName: string;
  isConnected: boolean;
  folders: Folder[] | null;
  sessions: SessionSummary[] | null;
};

// Without a machineId, a ping goes to all of the person's connected machines.
// A new session's name is optional: the machine names it after its folder.
export type PageToServer =
  | { type: "ping"; machineId?: string }
  | ({ type: "start-session"; machineId: string; folderName: string; sessionName?: string } & Request)
  | ({ type: "send-to-session"; machineId: string; sessionName: string; text: string; images?: SentImage[] } & Request)
  | ({ type: "ask-for-output"; machineId: string; sessionName: string; kind: string } & Request)
  | ({ type: "answer-output"; machineId: string; sessionName: string; outputId: string; choice: number } & Request)
  | ({ type: "answer-permission"; machineId: string; sessionName: string; toolUseId: string; isAllowed: boolean } & Request)
  | ({ type: "interrupt-session"; machineId: string; sessionName: string } & Request)
  | ({ type: "stop-session"; machineId: string; sessionName: string } & Request);

export type ServerToPage =
  | { type: "machines"; machines: MachineSummary[] }
  | { type: "pong"; machineId: string; machineName: string; roundTripMs: number }
  | { type: "session-entries"; machineId: string; sessionName: string; entries: SessionEntry[] }
  | ({ type: "message-returned"; machineId: string; sessionName: string; text: string } & Request)
  | ({ type: "error"; message: string } & Request);

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
