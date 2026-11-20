import { COPIED_LIMITS as LIMITS } from "./limits";

// A session's state, as Claude Code's hooks report it.
// starting: Claude Code is loading. idle: waiting for a message.
// working: answering. needs-you: waiting on a question in its terminal
// (like a permission prompt), so someone has to attach and answer it.
export const SESSION_STATES = ["starting", "idle", "working", "needs-you"] as const;
export type SessionState = (typeof SESSION_STATES)[number];

// status and decision are talos's kinds; talos's session-bridge.ts checks them.
export type SessionSummary = {
  sessionName: string;
  folderName: string;
  state: SessionState;
  status?: unknown;
  decision?: unknown;
};

// One thing in a session's conversation, read from Claude Code's saved
// conversation as it grows: a message someone sent, text Claude wrote, or a
// tool Claude ran. A tool is sent again, with the same entryId, when it ends.
export const TOOL_OUTCOMES = ["running", "done", "failed"] as const;
export type ToolOutcome = (typeof TOOL_OUTCOMES)[number];

export type SessionEntry =
  | { kind: "prompt"; entryId: string; text: string; imageCount: number }
  | { kind: "text"; entryId: string; text: string }
  | { kind: "tool"; entryId: string; toolName: string; summary: string; outcome: ToolOutcome };

// An image sent with a message, as base64.
export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];
export type SentImage = { mediaType: ImageMediaType; dataBase64: string };

const isTextUpTo = (value: unknown, maxLength: number): value is string =>
  typeof value === "string" && value.length <= maxLength;

const isOneOf = <T extends string>(choices: readonly T[], value: unknown): value is T =>
  choices.some((choice) => choice === value);

const fieldOf = (item: object, field: string): unknown => Reflect.get(item, field);

const IDENTIFIER_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// A name in identifier form ("fix-login"), so it can't carry path pieces like
// "../.." into a command or a path.
export const isIdentifierName = (value: unknown): value is string =>
  typeof value === "string" && value.length <= LIMITS.maxIdentifierLength && IDENTIFIER_NAME.test(value);

export const readSessionList = (value: unknown): SessionSummary[] | null => {
  if (!Array.isArray(value) || value.length > LIMITS.maxSessions) return null;
  const isSession = (item: unknown): boolean =>
    typeof item === "object" &&
    item !== null &&
    isIdentifierName(fieldOf(item, "sessionName")) &&
    isIdentifierName(fieldOf(item, "folderName")) &&
    isOneOf(SESSION_STATES, fieldOf(item, "state"));
  if (!value.every(isSession)) return null;
  return value.map((item) => {
    const { sessionName, folderName, state, status, decision } = item as SessionSummary;
    return { sessionName, folderName, state, ...(status !== undefined && { status }), ...(decision !== undefined && { decision }) };
  });
};

// One entry, or null if it isn't a valid one. Whoever makes entries checks each
// with this, since readSessionEntries turns down a whole list for one bad entry.
export const readSessionEntry = (item: unknown): SessionEntry | null => {
  if (typeof item !== "object" || item === null) return null;
  const entryId = fieldOf(item, "entryId");
  const kind = fieldOf(item, "kind");
  if (!isTextUpTo(entryId, LIMITS.maxIdTextLength)) return null;

  if (kind === "prompt") {
    const text = fieldOf(item, "text");
    const imageCount = fieldOf(item, "imageCount");
    const hasImageCount = Number.isInteger(imageCount) && Number(imageCount) >= 0;
    return isTextUpTo(text, LIMITS.maxEntryTextLength) && hasImageCount
      ? { kind, entryId, text, imageCount: Number(imageCount) }
      : null;
  }
  if (kind === "text") {
    const text = fieldOf(item, "text");
    return isTextUpTo(text, LIMITS.maxEntryTextLength) ? { kind, entryId, text } : null;
  }
  if (kind === "tool") {
    const toolName = fieldOf(item, "toolName");
    const summary = fieldOf(item, "summary");
    const outcome = fieldOf(item, "outcome");
    const isTool =
      isTextUpTo(toolName, LIMITS.maxNameTextLength) &&
      isTextUpTo(summary, LIMITS.maxToolSummaryLength) &&
      isOneOf(TOOL_OUTCOMES, outcome);
    return isTool ? { kind, entryId, toolName, summary, outcome } : null;
  }
  return null;
};

export const readSessionEntries = (value: unknown): SessionEntry[] | null => {
  if (!Array.isArray(value) || value.length > LIMITS.maxEntriesKept) return null;
  const entries = value.map(readSessionEntry);
  return entries.every((entry) => entry !== null) ? (entries as SessionEntry[]) : null;
};

export const readSentImages = (value: unknown): SentImage[] | null => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > LIMITS.maxImagesPerMessage) return null;
  const isImage = (item: unknown): item is SentImage =>
    typeof item === "object" &&
    item !== null &&
    isOneOf(IMAGE_MEDIA_TYPES, fieldOf(item, "mediaType")) &&
    isTextUpTo(fieldOf(item, "dataBase64"), LIMITS.maxImageBase64Length);
  if (!value.every(isImage)) return null;
  return value.map(({ mediaType, dataBase64 }) => ({ mediaType, dataBase64 }));
};

const hasEntryId = (entry: SessionEntry): boolean => typeof entry?.entryId === "string";

const entryTextLength = (entry: SessionEntry): number =>
  entry.kind === "tool" ? entry.toolName.length + entry.summary.length : entry.text.length;

// The newest entries whose text fits the kept budget. Entries keep their
// objects (talos's resend relies on an unchanged entry staying the same object).
const keepNewestWithinTextBudget = (entries: SessionEntry[]): SessionEntry[] => {
  let keptText = 0;
  let firstKeptIndex = entries.length;
  while (firstKeptIndex > 0 && keptText + entryTextLength(entries[firstKeptIndex - 1]) <= LIMITS.maxKeptEntryTextLength) {
    firstKeptIndex -= 1;
    keptText += entryTextLength(entries[firstKeptIndex]);
  }
  return firstKeptIndex === 0 ? entries : entries.slice(firstKeptIndex);
};

// Entries arrive again when a tool ends, or after a reconnect. The newer
// copy replaces the older one in place, and new ones go on the end.
export const mergeSessionEntries = (keptEntries: SessionEntry[], newEntries: SessionEntry[], maxKept: number): SessionEntry[] => {
  const newEntryById = new Map(newEntries.filter(hasEntryId).map((entry) => [entry.entryId, entry]));
  const keptIds = new Set(keptEntries.map((entry) => entry.entryId));
  const updatedEntries = keptEntries.map((entry) => newEntryById.get(entry.entryId) ?? entry);
  const addedEntries = [...newEntryById.values()].filter((entry) => !keptIds.has(entry.entryId));
  return keepNewestWithinTextBudget([...updatedEntries, ...addedEntries].slice(-maxKept));
};
