import { parseJsonOrNull, readSessionEntries, readSessionList, type SessionEntry, type SessionSummary } from "talos-shared";

// What the session host streams to talos: the session list whenever it
// changes, and each session's entries as Claude Code saves them.
export type HostEvent =
  | { type: "sessions"; sessions: SessionSummary[] }
  | { type: "session-entries"; sessionName: string; entries: SessionEntry[] };

export type StartSessionRequest = { sessionName: string; folderName: string; path: string };

export const HOST_ROUTES = {
  health: "/health",
  events: "/events",
  sessions: "/sessions",
  stop: "/stop",
  hooks: "/hooks/:sessionName",
} as const;

export const sessionRoute = (sessionName: string, action: "send" | "stop" | "output" | "input" | "resize") =>
  `${HOST_ROUTES.sessions}/${encodeURIComponent(sessionName)}/${action}`;

// One event per line, so a stream can be read line by line.
export const encodeHostEvent = (hostEvent: HostEvent): string => `${JSON.stringify(hostEvent)}\n`;

export const parseHostEvent = (line: string): HostEvent | null => {
  const value = parseJsonOrNull(line);
  if (typeof value !== "object" || value === null) return null;
  const eventType: unknown = Reflect.get(value, "type");
  if (eventType === "sessions") {
    const sessions = readSessionList(Reflect.get(value, "sessions"));
    return sessions ? { type: "sessions", sessions } : null;
  }
  if (eventType === "session-entries") {
    const sessionName: unknown = Reflect.get(value, "sessionName");
    const entries = readSessionEntries(Reflect.get(value, "entries"));
    return typeof sessionName === "string" && entries ? { type: "session-entries", sessionName, entries } : null;
  }
  return null;
};
