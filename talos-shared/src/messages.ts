import { parseJsonOrNull } from "./json";

export type ServerToMachine = { type: "ping"; id: string };
export type MachineToServer = { type: "pong"; id: string };

export type CurrentUserResponse = { login: string };
export type MachineCheckResponse = { machineName: string };

export type MachineSummary ={ machineId: string; machineName: string; isConnected: boolean };

export type PageToServer = { type: "ping" };
export type ServerToPage =
  | { type: "machines"; machines: MachineSummary[] }
  | { type: "pong"; machineName: string; roundTripMs: number }
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
