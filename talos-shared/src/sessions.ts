import { isIdentifierName } from "./identifiers";
import { LIMITS } from "./limits";

// A session's state, as Claude Code's hooks report it.
// starting: Claude Code is loading. idle: waiting for a message.
// working: answering. needs-you: waiting on a question in its terminal
// (like a permission prompt), so someone has to attach and answer it.
export const SESSION_STATES = ["starting", "idle", "working", "needs-you"] as const;
export type SessionState = (typeof SESSION_STATES)[number];

// For each kind talos asks for (like status): where the latest ask stands, and
// its latest answer. Open outputs are questions waiting for the person, each
// with its id. Their fields are a kind's own; the page reads talos's kinds with
// statusOf and openDecisionOf below.
export const ASK_STATES = ["asking", "answered", "no-response"] as const;
export type AskState = (typeof ASK_STATES)[number];
export type OutputFields = Record<string, unknown>;
export type Ask = { state: AskState; atMs: number; latest?: OutputFields };
export type OpenOutput = { id: string; kind: string; fields: OutputFields; atMs: number };

export type SessionSummary = {
  sessionName: string;
  folderName: string;
  state: SessionState;
  asks: Record<string, Ask>;
  openOutputs: OpenOutput[];
};

// A question the session asked the person while working, with the choices it
// offered. A click answers it by its id and the choice's position; the message
// box answers in the person's own words. It lasts one turn.
export type SessionDecision = { id: string; question: string; choices: string[]; atMs: number };

// A session's structured status, filled in when someone asks for an update.
// The session itself picks one of REPORTED_STATUSES via the report_status tool;
// the session runner adds "pending" (asked, waiting) and "no-response" (didn't report).
export const REPORTED_STATUSES = ["working", "waiting", "done", "stuck"] as const;
export type ReportedStatus = (typeof REPORTED_STATUSES)[number];
export const SESSION_STATUS_STATES = [...REPORTED_STATUSES, "pending", "no-response"] as const;
export type SessionStatusState = (typeof SESSION_STATUS_STATES)[number];
export type SessionStatus = { state: SessionStatusState; note: string; atMs: number };

// One thing in a session's conversation, read from Claude Code's saved
// conversation as it grows: a message someone sent, text Claude wrote, or a
// tool Claude ran. A tool is sent again, with the same entryId, when it ends.
export const TOOL_OUTCOMES = ["running", "done", "failed"] as const;
export type ToolOutcome = (typeof TOOL_OUTCOMES)[number];

export type UnnumberedEntry =
  | { kind: "prompt"; entryId: string; text: string; imageCount: number }
  | { kind: "text"; entryId: string; text: string }
  | { kind: "tool"; entryId: string; toolName: string; summary: string; outcome: ToolOutcome }
  // A structured output the session sent in a normal turn, like a decision.
  | { kind: "output"; entryId: string; outputKind: string; fields: OutputFields }
  // Stands in for an item that failed its check, so the other end sees something
  // was there. The bad data itself never travels.
  | { kind: "dropped"; entryId: string; droppedKind: string; reason: string };

// position is the item's place in its session's conversation, counted by the
// session runner as it reads it. Every side keeps entries in that order and
// trims the lowest first, so an old entry that arrives again can't come back
// as the newest.
export type SessionEntry = UnnumberedEntry & { position: number };

// An image sent with a message, as base64.
export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];
export type SentImage = { mediaType: ImageMediaType; dataBase64: string };

const isTextUpTo = (value: unknown, maxLength: number): value is string =>
  typeof value === "string" && value.length <= maxLength;

const isOneOf = <T extends string>(choices: readonly T[], value: unknown): value is T =>
  choices.some((choice) => choice === value);

const fieldOf = (item: object, field: string): unknown => Reflect.get(item, field);

// A reported status, or null for anything that isn't one. Both sides read it
// from messages, so neither trusts the shape.
export const readSessionStatus = (value: unknown): SessionStatus | null => {
  if (typeof value !== "object" || value === null) return null;
  const state = fieldOf(value, "state");
  const note = fieldOf(value, "note");
  const atMs = fieldOf(value, "atMs");
  const isStatus = isOneOf(SESSION_STATUS_STATES, state) && isTextUpTo(note, LIMITS.maxStatusNoteLength) && typeof atMs === "number";
  return isStatus ? { state: state as SessionStatusState, note: note as string, atMs: atMs as number } : null;
};

// A decision, or null for anything that isn't one.
export const readSessionDecision = (value: unknown): SessionDecision | null => {
  if (typeof value !== "object" || value === null) return null;
  const id = fieldOf(value, "id");
  const question = fieldOf(value, "question");
  const choices = fieldOf(value, "choices");
  const atMs = fieldOf(value, "atMs");
  const hasChoices =
    Array.isArray(choices) &&
    choices.length >= LIMITS.minDecisionChoices &&
    choices.length <= LIMITS.maxDecisionChoices &&
    choices.every((choice) => isTextUpTo(choice, LIMITS.maxDecisionChoiceLength) && choice.length > 0);
  const isDecision = isTextUpTo(question, LIMITS.maxDecisionQuestionLength) && question.length > 0 && hasChoices && typeof atMs === "number";
  return isDecision && isTextUpTo(id, LIMITS.maxIdTextLength) && id.length > 0 ? { id, question, choices: [...(choices as string[])], atMs } : null;
};

const textEncoder = new TextEncoder();
const byteLengthOf = (value: unknown): number => textEncoder.encode(JSON.stringify(value)).length;

const isFields = (value: unknown): value is OutputFields =>
  typeof value === "object" && value !== null && !Array.isArray(value) && byteLengthOf(value) <= LIMITS.maxOutputFieldsBytes;

// A bad ask or open output is left out rather than the whole session.
const readAsks = (value: unknown): Record<string, Ask> => {
  if (typeof value !== "object" || value === null) return {};
  const readAsk = (ask: unknown): Ask | null => {
    if (typeof ask !== "object" || ask === null) return null;
    const [state, atMs, latest] = ["state", "atMs", "latest"].map((field) => fieldOf(ask, field));
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
    if (typeof output !== "object" || output === null) return [];
    const [id, kind, fields, atMs] = ["id", "kind", "fields", "atMs"].map((field) => fieldOf(output, field));
    const isOutput = isTextUpTo(id, LIMITS.maxIdTextLength) && isTextUpTo(kind, LIMITS.maxNameTextLength) && isFields(fields) && typeof atMs === "number";
    return isOutput ? [{ id: id as string, kind: kind as string, fields, atMs }] : [];
  });

// talos's own kinds, read from the general shape. A status ask that's still
// asking shows as "pending"; a decision is the first open one.
export const statusOf = (session: SessionSummary): SessionStatus | null => {
  const ask = session.asks.status;
  if (!ask) return null;
  if (ask.state === "asking") return { state: "pending", note: "", atMs: ask.atMs };
  if (ask.state === "no-response") return { state: "no-response", note: "", atMs: ask.atMs };
  return readSessionStatus({ ...ask.latest, atMs: ask.atMs });
};

export const openDecisionOf = (session: SessionSummary): SessionDecision | null => {
  const output = session.openOutputs.find(({ kind }) => kind === "decision");
  return output ? readSessionDecision({ ...output.fields, id: output.id, atMs: output.atMs }) : null;
};

// Both sides read these from messages, so neither trusts the shape.
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
const isPosition = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

export const readSessionEntry = (item: unknown): SessionEntry | null => {
  if (typeof item !== "object" || item === null) return null;
  const position = fieldOf(item, "position");
  if (!isPosition(position)) return null;
  const entry = readUnnumberedEntry(item);
  return entry && { ...entry, position };
};

const readUnnumberedEntry = (item: object): UnnumberedEntry | null => {
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
  const position = typeof item === "object" && item !== null ? fieldOf(item, "position") : undefined;
  const hasReadableId = typeof entryId === "string" && entryId.length > 0 && entryId.length <= LIMITS.maxIdTextLength;
  return {
    kind: "dropped",
    entryId: hasReadableId ? entryId : `dropped:${hashOf(String(JSON.stringify(item) ?? "").slice(0, MAX_HASHED_LENGTH))}`,
    droppedKind: isTextUpTo(kind, LIMITS.maxNameTextLength) ? kind : "unknown",
    reason: reason.slice(0, LIMITS.maxNameTextLength),
    position: isPosition(position) ? position : 0,
  };
};

// Only the newest markers are kept, so a flood of bad items can't push out real
// ones. Counted by position, not id: many copies of one bad item share an id.
export const capDroppedMarkers = (entries: SessionEntry[], maxMarkers: number): SessionEntry[] => {
  const markerPositions = entries.flatMap((entry, position) => (entry.kind === "dropped" ? [position] : []));
  const leftOutCount = Math.max(0, markerPositions.length - maxMarkers);
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

// Entries arrive again when a tool ends, or after a reconnect: the newer copy
// replaces the older. All are kept in conversation order, newest last.
export const mergeSessionEntries = (keptEntries: SessionEntry[], newEntries: SessionEntry[], maxKept: number): SessionEntry[] => {
  const entryById = new Map(keptEntries.map((entry) => [entry.entryId, entry]));
  newEntries.filter(hasEntryId).forEach((entry) => entryById.set(entry.entryId, entry));
  const inConversationOrder = [...entryById.values()].sort((first, second) => first.position - second.position);
  // Markers are capped first, so ones the cap drops don't take real entries' places.
  return keepNewestWithinTextBudget(capDroppedMarkers(inConversationOrder, LIMITS.maxDroppedKept).slice(-maxKept));
};

