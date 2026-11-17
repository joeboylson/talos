import { parseJsonOrNull, readExchange, readSessionList, type Exchange, type SessionSummary } from "talos-shared";

// What the session host streams to talos: the session list whenever it
// changes, and each finished exchange.
export type HostEvent =
  | { type: "sessions"; sessions: SessionSummary[] }
  | { type: "exchange"; sessionName: string; exchange: Exchange };

export type StartSessionRequest = { sessionName: string; folderName: string; path: string };

export const HOST_ROUTES = {
  health: "/health",
  events: "/events",
  sessions: "/sessions",
  stop: "/stop",
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
  if (eventType === "exchange") {
    const sessionName: unknown = Reflect.get(value, "sessionName");
    const exchange = readExchange(Reflect.get(value, "exchange"));
    return typeof sessionName === "string" && exchange ? { type: "exchange", sessionName, exchange } : null;
  }
  return null;
};
