import { isIdentifierName } from "./identifiers";
import { parseJsonOrNull } from "./json";

// A session's state, as Claude Code's hooks report it.
// starting: Claude Code is loading. idle: waiting for a message.
// working: answering. needs-you: waiting on a question in its terminal
// (like a permission prompt), so someone has to attach and answer it.
export const SESSION_STATES = ["starting", "idle", "working", "needs-you"] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export type SessionSummary = { sessionName: string; folderName: string; state: SessionState };

// One thing in a session's conversation, read from Claude Code's saved
// conversation as it grows: a message someone sent, text Claude wrote, or a
// tool Claude ran. A tool is sent again, with the same entryId, when it ends.
export const TOOL_OUTCOMES = ["running", "done", "failed"] as const;
export type ToolOutcome = (typeof TOOL_OUTCOMES)[number];

export type SessionEntry =
  | { kind: "prompt"; entryId: string; text: string; imageCount: number }
  | { kind: "text"; entryId: string; text: string }
  | { kind: "tool"; entryId: string; toolName: string; summary: string; outcome: ToolOutcome };

// An image sent with a message, as base64. The page shrinks images before
// sending, so these limits are rarely reached.
export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];
export type SentImage = { mediaType: ImageMediaType; dataBase64: string };
export const MAX_IMAGES_PER_MESSAGE = 4;
export const MAX_IMAGE_BASE64_LENGTH = 3_000_000;

export const MAX_SESSIONS = 50;
export const MAX_ENTRY_TEXT_LENGTH = 100_000;
// Each side keeps this many of a session's latest entries, and sends at most
// this many at once.
export const MAX_ENTRIES_KEPT = 500;
const MAX_NAME_TEXT_LENGTH = 100;
const MAX_ID_TEXT_LENGTH = 200;
const MAX_TOOL_SUMMARY_LENGTH = 1000;

const isTextUpTo = (value: unknown, maxLength: number): value is string =>
  typeof value === "string" && value.length <= maxLength;

const isOneOf = <T extends string>(choices: readonly T[], value: unknown): value is T =>
  choices.some((choice) => choice === value);

const fieldOf = (item: object, field: string): unknown => Reflect.get(item, field);

// Both sides read these from messages, so neither trusts the shape.
export const readSessionList = (value: unknown): SessionSummary[] | null => {
  if (!Array.isArray(value) || value.length > MAX_SESSIONS) return null;
  const isSession = (item: unknown): item is SessionSummary =>
    typeof item === "object" &&
    item !== null &&
    isIdentifierName(fieldOf(item, "sessionName")) &&
    isIdentifierName(fieldOf(item, "folderName")) &&
    isOneOf(SESSION_STATES, fieldOf(item, "state"));
  if (!value.every(isSession)) return null;
  return value.map(({ sessionName, folderName, state }) => ({ sessionName, folderName, state }));
};

const readSessionEntry = (item: unknown): SessionEntry | null => {
  if (typeof item !== "object" || item === null) return null;
  const entryId = fieldOf(item, "entryId");
  const kind = fieldOf(item, "kind");
  if (!isTextUpTo(entryId, MAX_ID_TEXT_LENGTH)) return null;

  if (kind === "prompt") {
    const text = fieldOf(item, "text");
    const imageCount = fieldOf(item, "imageCount");
    const hasImageCount = Number.isInteger(imageCount) && Number(imageCount) >= 0;
    return isTextUpTo(text, MAX_ENTRY_TEXT_LENGTH) && hasImageCount
      ? { kind, entryId, text, imageCount: Number(imageCount) }
      : null;
  }
  if (kind === "text") {
    const text = fieldOf(item, "text");
    return isTextUpTo(text, MAX_ENTRY_TEXT_LENGTH) ? { kind, entryId, text } : null;
  }
  if (kind === "tool") {
    const toolName = fieldOf(item, "toolName");
    const summary = fieldOf(item, "summary");
    const outcome = fieldOf(item, "outcome");
    const isTool =
      isTextUpTo(toolName, MAX_NAME_TEXT_LENGTH) &&
      isTextUpTo(summary, MAX_TOOL_SUMMARY_LENGTH) &&
      isOneOf(TOOL_OUTCOMES, outcome);
    return isTool ? { kind, entryId, toolName, summary, outcome } : null;
  }
  return null;
};

export const readSessionEntries = (value: unknown): SessionEntry[] | null => {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES_KEPT) return null;
  const entries = value.map(readSessionEntry);
  return entries.every((entry) => entry !== null) ? (entries as SessionEntry[]) : null;
};

export const parseSessionEntries = (text: string): SessionEntry[] | null => readSessionEntries(parseJsonOrNull(text));

export const readSentImages = (value: unknown): SentImage[] | null => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_IMAGES_PER_MESSAGE) return null;
  const isImage = (item: unknown): item is SentImage =>
    typeof item === "object" &&
    item !== null &&
    isOneOf(IMAGE_MEDIA_TYPES, fieldOf(item, "mediaType")) &&
    isTextUpTo(fieldOf(item, "dataBase64"), MAX_IMAGE_BASE64_LENGTH);
  if (!value.every(isImage)) return null;
  return value.map(({ mediaType, dataBase64 }) => ({ mediaType, dataBase64 }));
};

// Entries arrive again when a tool ends, or after a reconnect. The newer
// copy replaces the older one in place, and new ones go on the end.
export const mergeSessionEntries = (
  keptEntries: SessionEntry[],
  newEntries: SessionEntry[],
  maxKept: number,
): SessionEntry[] => {
  const newEntryById = new Map(newEntries.map((entry) => [entry.entryId, entry]));
  const keptIds = new Set(keptEntries.map((entry) => entry.entryId));
  const updatedEntries = keptEntries.map((entry) => newEntryById.get(entry.entryId) ?? entry);
  const addedEntries = [...newEntryById.values()].filter((entry) => !keptIds.has(entry.entryId));
  return [...updatedEntries, ...addedEntries].slice(-maxKept);
};
