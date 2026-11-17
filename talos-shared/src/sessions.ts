import { parseJsonOrNull } from "./json";

// A session's state, as Claude Code's hooks report it.
// starting: Claude Code is loading. idle: waiting for a message.
// working: answering. needs-you: waiting on a question in its terminal
// (like a permission prompt), so someone has to attach and answer it.
export const SESSION_STATES = ["starting", "idle", "working", "needs-you"] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export type SessionSummary = { sessionName: string; folderName: string; state: SessionState };

// One message and Claude's answer to it, read from the saved conversation
// when Claude finishes. Messages typed in the terminal show up here too.
export type Exchange = { prompt: string; reply: string; finishedAtMs: number };

export const MAX_SESSIONS = 50;
export const MAX_EXCHANGE_TEXT_LENGTH = 100_000;
const MAX_NAME_TEXT_LENGTH = 100;

const isTextUpTo = (value: unknown, maxLength: number): value is string =>
  typeof value === "string" && value.length <= maxLength;

const isSessionState = (value: unknown): value is SessionState => SESSION_STATES.some((state) => state === value);

// Both sides read these from messages, so neither trusts the shape.
export const readSessionList = (value: unknown): SessionSummary[] | null => {
  if (!Array.isArray(value) || value.length > MAX_SESSIONS) return null;
  const isSession = (item: unknown): item is SessionSummary =>
    typeof item === "object" &&
    item !== null &&
    isTextUpTo(Reflect.get(item, "sessionName"), MAX_NAME_TEXT_LENGTH) &&
    isTextUpTo(Reflect.get(item, "folderName"), MAX_NAME_TEXT_LENGTH) &&
    isSessionState(Reflect.get(item, "state"));
  if (!value.every(isSession)) return null;
  return value.map(({ sessionName, folderName, state }) => ({ sessionName, folderName, state }));
};

export const readExchange = (value: unknown): Exchange | null => {
  if (typeof value !== "object" || value === null) return null;
  const prompt: unknown = Reflect.get(value, "prompt");
  const reply: unknown = Reflect.get(value, "reply");
  const finishedAtMs: unknown = Reflect.get(value, "finishedAtMs");
  const isExchange =
    isTextUpTo(prompt, MAX_EXCHANGE_TEXT_LENGTH) &&
    isTextUpTo(reply, MAX_EXCHANGE_TEXT_LENGTH) &&
    typeof finishedAtMs === "number";
  return isExchange ? { prompt, reply, finishedAtMs } : null;
};

export const parseExchange = (text: string): Exchange | null => readExchange(parseJsonOrNull(text));
