import type { BunRequest } from "bun";
import { parseJsonOrNull } from "../json";
import { readSessionEntries, readSessionList, type SessionEntry, type SessionSummary } from "../shapes";

// What the session runner streams to talos: the session list whenever it
// changes, and each session's entries as Claude Code saves them.
export type RunnerEvent =
  | { type: "sessions"; sessions: SessionSummary[] }
  | { type: "session-entries"; sessionName: string; entries: SessionEntry[] };

export type StartSessionRequest = { sessionName: string; folderName: string; path: string };

export const RUNNER_ROUTES = {
  health: "/health",
  events: "/events",
  sessions: "/sessions",
  stop: "/stop",
} as const;

// The hooks socket speaks one JSON line each way, not HTTP, so the session runner can
// count and close its connections (a flood of idle ones would otherwise use up
// its files). The hook sends its session, token and Claude Code's details; the
// session runner answers with the hook's reply, or says the request was too big to read.
export type HookRequest = { sessionName: string; token: string; details: string };
export type HookAnswer = { kind: "reply"; reply: string } | { kind: "too-big" };

export const encodeHookLine = (value: HookRequest | HookAnswer): string => `${JSON.stringify(value)}\n`;

const fieldOf = (value: unknown, field: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, field) : undefined;

export const readHookRequest = (line: string): HookRequest | null => {
  const value = parseJsonOrNull(line);
  const [sessionName, token, details] = ["sessionName", "token", "details"].map((field) => fieldOf(value, field));
  const isRequest = typeof sessionName === "string" && typeof token === "string" && typeof details === "string";
  return isRequest ? { sessionName, token, details } : null;
};

export const readHookAnswer = (line: string): HookAnswer | null => {
  const value = parseJsonOrNull(line);
  const kind = fieldOf(value, "kind");
  const reply = fieldOf(value, "reply");
  if (kind === "too-big") return { kind };
  return kind === "reply" && typeof reply === "string" ? { kind, reply } : null;
};

export const sessionRoute = (sessionName: string, action: "send" | "stop" | "ask-update" | "output" | "input" | "resize") =>
  `${RUNNER_ROUTES.sessions}/${encodeURIComponent(sessionName)}/${action}`;

// One event per line, so a stream can be read line by line.
export const encodeRunnerEvent = (runnerEvent: RunnerEvent): string => `${JSON.stringify(runnerEvent)}\n`;

export const parseRunnerEvent = (line: string): RunnerEvent | null => {
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

export const sessionNameOf = (request: BunRequest): string => request.params.sessionName ?? "";
