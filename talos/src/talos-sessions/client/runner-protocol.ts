import type { BunRequest } from "bun";
import { parseJsonOrNull } from "../json";
import { readSessionEntries, readSessionList, type SessionEntry, type SessionSummary } from "../shapes";

// What the session runner streams to talos: the session list whenever it
// changes, and each session's entries as Claude Code saves them.
export type RunnerEvent =
  | { type: "sessions"; sessions: SessionSummary[] }
  | { type: "session-entries"; sessionName: string; entries: SessionEntry[] }
  // Something the owner asked for that didn't happen, like a held answer dropped.
  | { type: "notice"; sessionName: string; message: string }
  // A message that waited for its turn and won't go in (after an interrupt),
  // given back to the page that sent it (its request id).
  | { type: "message-returned"; sessionName: string; text: string; requestId?: string };

// What the session runner sends when it turns a request down: a fixed code a
// program can check, and a reason to show. A malformed request isn't a refusal:
// it's a bug in the caller, answered with 400 and plain text.
export const REFUSAL_CODES = [
  "no-such-session",
  "already-running",
  "too-many-sessions",
  "folder-not-allowed",
  "already-asking",
  "closed",
  "not-a-choice",
  "not-sendable",
  "too-many-waiting",
  "stopped",
  "link-lost",
  "no-claude-code",
  "not-running",
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];
export type Refusal = { code: RefusalCode; reason: string };

export const readRefusal = (value: unknown): Refusal | null => {
  const code = typeof value === "object" && value !== null ? Reflect.get(value, "code") : undefined;
  const reason = typeof value === "object" && value !== null ? Reflect.get(value, "reason") : undefined;
  const knownCode = REFUSAL_CODES.find((known) => known === code);
  return knownCode && typeof reason === "string" ? { code: knownCode, reason } : null;
};

export type StartSessionRequest = { sessionName: string; folderName: string; path: string };

export const RUNNER_ROUTES = {
  health: "/health",
  events: "/events",
  sessions: "/sessions",
  stop: "/stop",
} as const;

export const sessionRoute = (
  sessionName: string,
  action: "send" | "stop" | "interrupt" | "ask" | "answer" | "answer-permission",
) =>
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
  if (eventType === "notice") {
    const sessionName: unknown = Reflect.get(value, "sessionName");
    const message: unknown = Reflect.get(value, "message");
    return typeof sessionName === "string" && typeof message === "string" ? { type: "notice", sessionName, message } : null;
  }
  if (eventType === "message-returned") {
    const [sessionName, text, requestId] = ["sessionName", "text", "requestId"].map((field) => Reflect.get(value, field));
    if (typeof sessionName !== "string" || typeof text !== "string") return null;
    return { type: "message-returned", sessionName, text, ...(typeof requestId === "string" && { requestId }) };
  }
  return null;
};

export const sessionNameOf = (request: BunRequest): string => request.params.sessionName ?? "";
