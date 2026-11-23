import type { BunRequest } from "bun";
import { parseJsonOrNull } from "../json";
import { readSessionEntries, readSessionList, type SessionEntry, type SessionSummary } from "../shapes";

// What the session runner streams to talos: the session list whenever it
// changes, and each session's entries as Claude Code saves them.
export type RunnerEvent =
  | { type: "sessions"; sessions: SessionSummary[] }
  | { type: "session-entries"; sessionName: string; entries: SessionEntry[] }
  // Something the owner asked for that didn't happen, like a held answer dropped.
  | { type: "notice"; sessionName: string; message: string };

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

// The hooks socket speaks one JSON line each way, not HTTP, so the session runner can
// count and close its connections (a flood of idle ones would otherwise use up
// its files). The hook sends its session, token and Claude Code's details; the
// session runner answers with the hook's reply, or says the request was too big to read.
// The session's MCP server asks the same way for the tools to list ("kinds"),
// and gets them, or "refused" for a bad token.
export type HookRequest =
  | { sessionName: string; token: string; details: string }
  | { sessionName: string; token: string; wants: "kinds" };
export type ListedTool = { name: string; description: string; inputSchema: object; reply: string };
export type HookAnswer =
  | { kind: "reply"; reply: string }
  | { kind: "too-big" }
  | { kind: "tools"; tools: ListedTool[] }
  | { kind: "refused" };

export const encodeHookLine = (value: HookRequest | HookAnswer): string => `${JSON.stringify(value)}\n`;

const fieldOf = (value: unknown, field: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, field) : undefined;

export const readHookRequest = (line: string): HookRequest | null => {
  const value = parseJsonOrNull(line);
  const [sessionName, token, details, wants] = ["sessionName", "token", "details", "wants"].map((field) => fieldOf(value, field));
  if (typeof sessionName !== "string" || typeof token !== "string") return null;
  if (wants === "kinds") return { sessionName, token, wants };
  return typeof details === "string" ? { sessionName, token, details } : null;
};

const readListedTool = (value: unknown): ListedTool | null => {
  const [name, description, inputSchema, reply] = ["name", "description", "inputSchema", "reply"].map((field) => fieldOf(value, field));
  const isTool = typeof name === "string" && typeof description === "string" && typeof reply === "string" && typeof inputSchema === "object" && inputSchema !== null;
  return isTool ? { name, description, inputSchema, reply } : null;
};

export const readHookAnswer = (line: string): HookAnswer | null => {
  const value = parseJsonOrNull(line);
  const kind = fieldOf(value, "kind");
  if (kind === "too-big" || kind === "refused") return { kind };
  if (kind === "tools") {
    const tools = fieldOf(value, "tools");
    const listed = Array.isArray(tools) ? tools.map(readListedTool) : [null];
    return listed.every((tool) => tool !== null) ? { kind, tools: listed as ListedTool[] } : null;
  }
  const reply = fieldOf(value, "reply");
  return kind === "reply" && typeof reply === "string" ? { kind, reply } : null;
};

export const sessionRoute = (sessionName: string, action: "send" | "stop" | "ask" | "answer" | "output" | "input" | "resize") =>
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
  return null;
};

export const sessionNameOf = (request: BunRequest): string => request.params.sessionName ?? "";
