import { COPIED_LIMITS as LIMITS } from "./limits";

// A session's state, as Claude Code's hooks report it.
// starting: Claude Code is loading. idle: waiting for a message.
// working: answering. needs-you: waiting on a question in its terminal
// (like a permission prompt), so someone has to attach and answer it.
export const SESSION_STATES = ["starting", "idle", "working", "needs-you"] as const;
export type SessionState = (typeof SESSION_STATES)[number];

// For each kind asked for: where the latest ask stands, and its latest answer.
export const ASK_STATES = ["asking", "answered", "no-response"] as const;
export type AskState = (typeof ASK_STATES)[number];
export type Ask = { state: AskState; atMs: number; latest?: Record<string, unknown> };
// An output the session sent that waits for the person's answer.
export type OpenOutput = { id: string; kind: string; fields: Record<string, unknown>; atMs: number };

// The fields are talos's kinds' own; talos's session-bridge.ts checks them.
export type SessionSummary = {
  sessionName: string;
  folderName: string;
  state: SessionState;
  asks: Record<string, Ask>;
  openOutputs: OpenOutput[];
};

// One thing in a session's conversation, read from Claude Code's saved
// conversation as it grows: a message someone sent, text Claude wrote, or a
// tool Claude ran. A tool is sent again, with the same entryId, when it ends.
export const TOOL_OUTCOMES = ["running", "done", "failed"] as const;
export type ToolOutcome = (typeof TOOL_OUTCOMES)[number];

export type SessionEntry =
  | { kind: "prompt"; entryId: string; text: string; imageCount: number }
  | { kind: "text"; entryId: string; text: string }
  | { kind: "tool"; entryId: string; toolName: string; summary: string; outcome: ToolOutcome }
  // A structured output the session sent in a normal turn, like a decision.
  | { kind: "output"; entryId: string; outputKind: string; fields: Record<string, unknown> }
  // Stands in for an item that failed its check, so the other end sees something
  // was there. The bad data itself never travels.
  | { kind: "dropped"; entryId: string; droppedKind: string; reason: string };

// An image sent with a message, as base64.
export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];
export type SentImage = { mediaType: ImageMediaType; dataBase64: string };

const isTextUpTo = (value: unknown, maxLength: number): value is string =>
  typeof value === "string" && value.length <= maxLength;

const isOneOf = <T extends string>(choices: readonly T[], value: unknown): value is T =>
  choices.some((choice) => choice === value);

const fieldOf = (item: object, field: string): unknown => Reflect.get(item, field);

const textEncoder = new TextEncoder();
export const jsonByteLength = (value: unknown): number => textEncoder.encode(JSON.stringify(value)).length;

const isFields = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && jsonByteLength(value) <= LIMITS.maxOutputFieldsBytes;

const IDENTIFIER_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// A name in identifier form ("fix-login"), so it can't carry path pieces like
// "../.." into a command or a path.
export const isIdentifierName = (value: unknown): value is string =>
  typeof value === "string" && value.length <= LIMITS.maxIdentifierLength && IDENTIFIER_NAME.test(value);


// A bad ask or open output is left out rather than turning down the whole list.
const readAsks = (value: unknown): Record<string, Ask> => {
  if (!isFields(value)) return {};
  const readAsk = (ask: unknown): Ask | null => {
    if (!isFields(ask)) return null;
    const { state, atMs, latest } = ask;
    if (!isOneOf(ASK_STATES, state) || typeof atMs !== "number") return null;
    return isFields(latest) ? { state, atMs, latest } : { state, atMs };
  };
  return Object.fromEntries(
    Object.entries(value).flatMap(([kind, ask]) => {
      const read = readAsk(ask);
      return read && isTextUpTo(kind, LIMITS.maxNameTextLength) ? [[kind, read]] : [];
    }),
  );
};

const readOpenOutputs = (value: unknown): OpenOutput[] =>
  (Array.isArray(value) ? value.slice(0, LIMITS.maxOpenOutputs) : []).flatMap((output: unknown) => {
    if (!isFields(output)) return [];
    const { id, kind, fields, atMs } = output;
    const isOutput = isTextUpTo(id, LIMITS.maxIdTextLength) && isTextUpTo(kind, LIMITS.maxNameTextLength) && isFields(fields) && typeof atMs === "number";
    return isOutput ? [{ id, kind, fields, atMs }] : [];
  });

export const readSessionList = (value: unknown): SessionSummary[] | null => {
  if (!Array.isArray(value) || value.length > LIMITS.maxSessions) return null;
  const isSession = (item: unknown): boolean =>
    typeof item === "object" &&
    item !== null &&
    isIdentifierName(fieldOf(item, "sessionName")) &&
    isIdentifierName(fieldOf(item, "folderName")) &&
    isOneOf(SESSION_STATES, fieldOf(item, "state"));
  // Each session is checked on its own: a bad one is left out, not the whole list.
  return value.filter(isSession).map((item) => {
    const { sessionName, folderName, state } = item as SessionSummary;
    return { sessionName, folderName, state, asks: readAsks(fieldOf(item as object, "asks")), openOutputs: readOpenOutputs(fieldOf(item as object, "openOutputs")) };
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
  if (kind === "output") {
    const outputKind = fieldOf(item, "outputKind");
    const fields = fieldOf(item, "fields");
    return isTextUpTo(outputKind, LIMITS.maxNameTextLength) && isFields(fields) ? { kind, entryId, outputKind, fields } : null;
  }
  if (kind === "dropped") {
    const droppedKind = fieldOf(item, "droppedKind");
    const reason = fieldOf(item, "reason");
    const isMarker = isTextUpTo(droppedKind, LIMITS.maxNameTextLength) && isTextUpTo(reason, LIMITS.maxNameTextLength);
    return isMarker ? { kind, entryId, droppedKind, reason } : null;
  }
  return null;
};

// A short, stable hash (FNV-1a), so the same bad item gets the same marker id
// each time it's sent and resends don't pile up markers.
const hashOf = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return (hash >>> 0).toString(16);
};
const MAX_HASHED_LENGTH = 10_000;

// The marker for a bad item: its own id if it has a readable one, so a good
// copy sent later replaces it.
export const toDroppedMarker = (item: unknown, reason: string): SessionEntry => {
  const entryId = typeof item === "object" && item !== null ? fieldOf(item, "entryId") : undefined;
  const kind = typeof item === "object" && item !== null ? fieldOf(item, "kind") : undefined;
  const hasReadableId = typeof entryId === "string" && entryId.length > 0 && entryId.length <= LIMITS.maxIdTextLength;
  return {
    kind: "dropped",
    entryId: hasReadableId ? entryId : `dropped:${hashOf(String(JSON.stringify(item) ?? "").slice(0, MAX_HASHED_LENGTH))}`,
    droppedKind: isTextUpTo(kind, LIMITS.maxNameTextLength) ? kind : "unknown",
    reason: reason.slice(0, LIMITS.maxNameTextLength),
  };
};

// Markers past the cap are left out, so a flood of bad items can't push out real ones.
// Counted by position, not id: bad items with no readable id share one.
export const capDroppedMarkers = (entries: SessionEntry[], maxMarkers: number): SessionEntry[] => {
  const markerPositions = entries.flatMap((entry, position) => (entry.kind === "dropped" ? [position] : []));
  const leftOutCount = Math.max(markerPositions.length - Math.max(maxMarkers, 0), 0);
  if (leftOutCount === 0) return entries;
  const leftOutPositions = new Set(markerPositions.slice(0, leftOutCount));
  return entries.filter((_entry, position) => !leftOutPositions.has(position));
};

// Each entry is checked on its own: a bad one becomes a dropped marker in its place.
export const readSessionEntries = (value: unknown): SessionEntry[] | null => {
  if (!Array.isArray(value) || value.length > LIMITS.maxEntriesKept) return null;
  const entries = value.map((item: unknown) => readSessionEntry(item) ?? toDroppedMarker(item, "failed its check"));
  return capDroppedMarkers(entries, LIMITS.maxDroppedPerBatch);
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

const entryTextLength = (entry: SessionEntry): number => {
  if (entry.kind === "tool") return entry.toolName.length + entry.summary.length;
  if (entry.kind === "dropped") return entry.reason.length;
  if (entry.kind === "output") return JSON.stringify(entry.fields).length;
  return entry.text.length;
};

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
  const keptIds = new Set(keptEntries.map((entry) => entry.entryId));
  const newEntryById = new Map(newEntries.filter(hasEntryId).map((entry) => [entry.entryId, entry]));
  const updatedEntries = keptEntries.map((entry) => newEntryById.get(entry.entryId) ?? entry);
  const addedEntries = [...newEntryById.values()].filter((entry) => !keptIds.has(entry.entryId));
  return capDroppedMarkers(keepNewestWithinTextBudget([...updatedEntries, ...addedEntries].slice(-maxKept)), LIMITS.maxDroppedKept);
};
