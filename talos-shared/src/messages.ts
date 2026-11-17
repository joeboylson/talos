export type ServerToMachine = { type: "ping"; id: string };
export type MachineToServer = { type: "pong"; id: string };

export type PageToServer = { type: "ping" };
export type ServerToPage =
  | { type: "machines"; machineNames: string[] }
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

// Bad JSON from the other side is expected input, not a bug, so it becomes null.
const parseJsonOrNull = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
