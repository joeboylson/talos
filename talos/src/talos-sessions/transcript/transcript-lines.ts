import { dirname } from "node:path";
import { parseJsonOrNull } from "../json";
import { SESSION_LIMITS } from "../limits";
import { STRUCTURED_TOOL_PREFIX } from "../kinds";
import { capDroppedMarkers, readSessionEntry, toDroppedMarker, type SessionEntry, type UnnumberedEntry } from "../shapes";
import { INTERRUPTED_NOTE, NEWLINE_BYTE, SENT_IMAGE_PATH, TOOL_SUMMARY_SHOWN_LENGTH } from "../constants";
import { removeControlCharacters } from "../terminal";

// One line of Claude Code's saved conversation (its .jsonl transcript), with
// only the fields talos reads.
type TranscriptLine = {
  type?: unknown;
  uuid?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  message?: { content?: unknown };
};
type ContentBlock = { type?: unknown; text?: unknown; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown; is_error?: unknown };
type ToolEntry = Extract<SessionEntry, { kind: "tool" }>;

// What one transcript line holds: entries, tools that ended (their results are
// saved as separate lines, after the tool's own line), and structured tool
// calls, which aren't shown but hold the place their output takes.
type ToolEnd = { kind: "tool-end"; toolUseId: string; isFailed: boolean };
type StructuredCall = { kind: "structured-call"; toolUseId: string };
export type TranscriptItem = UnnumberedEntry | ToolEnd | StructuredCall;
export type NumberedItem = SessionEntry | ToolEnd | (StructuredCall & { position: number });

const IMAGE_MARKER = /\[Image #\d+\]/g;
const COMMAND_OUTPUT = /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/;
// Claude Code's own notes, saved as messages, that nobody typed.
const NOTE_PREFIXES = ["<local-command-caveat>", "<system-reminder>", "<bash-stdout>", "<bash-stderr>"];

// Everything shown from the conversation goes through here. A session writes
// this text, so its control characters go: an escape sequence drawn in a
// terminal could clear it, retitle it or set the clipboard.
const truncate = (text: string, maxLength: number): string => {
  const shown = removeControlCharacters(text);
  return shown.length > maxLength ? shown.slice(0, maxLength) : shown;
};

const contentBlocksOf = (content: unknown): ContentBlock[] => {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is ContentBlock => typeof block === "object" && block !== null);
};

// A slash command or skill is saved as tags; show it the way it was typed.
// Found with indexOf, not a lazy regex: a session can write a prompt full of
// opening tags with no closing one, and the regex rescans to the end for each,
// freezing the session runner's one thread for minutes.
const textInTag = (text: string, tag: string): string | null => {
  const openTag = `<${tag}>`;
  const start = text.indexOf(openTag);
  if (start === -1) return null;
  const end = text.indexOf(`</${tag}>`, start + openTag.length);
  return end === -1 ? null : text.slice(start + openTag.length, end);
};

export const readCommandPrompt = (text: string): string | null => {
  const commandName = textInTag(text, "command-name")?.trim();
  if (!commandName) return null;
  const commandArgs = textInTag(text, "command-args")?.trim() ?? "";
  return `${commandName} ${commandArgs}`.trim();
};

const TOOL_SUMMARY_FIELDS = ["description", "command", "file_path", "path", "pattern", "url", "query", "skill", "prompt"];

// One line saying what a tool is doing, from its most telling input.
export const summarizeToolInput = (input: unknown): string => {
  if (typeof input !== "object" || input === null) return "";
  const firstTellingValue = TOOL_SUMMARY_FIELDS.map((field) => Reflect.get(input, field)).find(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  return truncate((firstTellingValue ?? "").replace(/\s+/g, " ").trim(), TOOL_SUMMARY_SHOWN_LENGTH);
};

// A message talos sent, as it was sent: without the note it put before it
// after an interrupt, and with the image paths it put after it counted as
// images. The page matches its waiting messages against this text.
export const readSentMessage = (text: string): { text: string; sentImageCount: number } => {
  const notePrefix = `${INTERRUPTED_NOTE}\n\n`;
  const paragraphs = (text.startsWith(notePrefix) ? text.slice(notePrefix.length) : text).split("\n\n");
  const firstPathAt = paragraphs.findLastIndex((paragraph) => !SENT_IMAGE_PATH.test(paragraph)) + 1;
  return { text: paragraphs.slice(0, firstPathAt).join("\n\n"), sentImageCount: paragraphs.length - firstPathAt };
};

const readPromptLine = (entryId: string, blocks: ContentBlock[]): UnnumberedEntry[] => {
  const typedText = blocks.flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : [])).join("\n");
  const imageCount = blocks.filter((block) => block.type === "image").length;
  const isNote = NOTE_PREFIXES.some((prefix) => typedText.trimStart().startsWith(prefix));
  if (isNote) return [];

  const commandOutput = COMMAND_OUTPUT.exec(typedText.trim())?.[1]?.trim();
  if (commandOutput !== undefined) {
    return commandOutput ? [{ kind: "text", entryId, text: truncate(commandOutput, SESSION_LIMITS.maxEntryTextLength) }] : [];
  }

  const sent = readSentMessage(typedText.replace(IMAGE_MARKER, ""));
  const promptText = (readCommandPrompt(typedText) ?? sent.text).trim();
  const shownImageCount = imageCount + sent.sentImageCount;
  if (!promptText && shownImageCount === 0) return [];
  return [{ kind: "prompt", entryId, text: truncate(promptText, SESSION_LIMITS.maxEntryTextLength), imageCount: shownImageCount }];
};

const readToolEnds = (blocks: ContentBlock[]): TranscriptItem[] =>
  blocks.flatMap((block) =>
    block.type === "tool_result" && typeof block.tool_use_id === "string"
      ? [{ kind: "tool-end" as const, toolUseId: block.tool_use_id, isFailed: block.is_error === true }]
      : [],
  );

const readAssistantLine = (lineId: string, blocks: ContentBlock[]): TranscriptItem[] =>
  blocks.flatMap((block, blockIndex): TranscriptItem[] => {
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      return [{ kind: "text", entryId: `${lineId}:${blockIndex}`, text: truncate(block.text, SESSION_LIMITS.maxEntryTextLength) }];
    }
    // A structured tool's call isn't shown: its output shows it, once it went
    // through, in this call's place.
    const isStructured = typeof block.name === "string" && block.name.startsWith(STRUCTURED_TOOL_PREFIX);
    if (block.type === "tool_use" && typeof block.id === "string" && isStructured) return [{ kind: "structured-call", toolUseId: block.id }];
    if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      const toolName = truncate(block.name, SESSION_LIMITS.maxNameTextLength);
      return [{ kind: "tool", entryId: block.id, toolName, summary: summarizeToolInput(block.input), outcome: "running" }];
    }
    return [];
  });

// Skips Claude's thinking, notes Claude Code adds itself (like a skill's
// instructions), and sub-agents' own conversations.
// A message the person typed while Claude was working is saved as a queued
// command inside the running turn, not as a prompt line of its own.
const readQueuedPrompt = (entryId: string, attachment: unknown): UnnumberedEntry[] => {
  const field = (name: string) => (typeof attachment === "object" && attachment !== null ? Reflect.get(attachment, name) : undefined);
  const prompt = field("prompt");
  const isTypedPrompt = field("type") === "queued_command" && field("commandMode") === "prompt" && typeof prompt === "string";
  return isTypedPrompt ? readPromptLine(entryId, [{ type: "text", text: prompt }]) : [];
};

export const readTranscriptLine = (lineText: string): TranscriptItem[] => {
  const line: unknown = parseJsonOrNull(lineText);
  if (typeof line !== "object" || line === null) return [];
  const { type, uuid, isMeta, isSidechain, message } = line as TranscriptLine;
  if (typeof uuid !== "string" || isMeta === true || isSidechain === true) return [];
  const blocks = contentBlocksOf(message?.content);
  if (type === "assistant") return readAssistantLine(uuid, blocks);
  if (type === "attachment") return readQueuedPrompt(uuid, Reflect.get(line, "attachment"));
  if (type !== "user") return [];
  const toolEnds = readToolEnds(blocks);
  return toolEnds.length > 0 ? toolEnds : readPromptLine(uuid, blocks);
};

// Turns tool ends into the ended tool's entry, using the tools seen so far.
// Returns the entries to send and the tools still known. Builds its result by
// mutating local copies rather than spreading the accumulator each item: the
// spread version was O(n^2), so one large transcript read (e.g. a resumed
// session's whole file) could block the single-threaded session runner for seconds.
// Tools are kept in a Map: a tool id comes from the transcript, and one named
// like an object's own property (toString, __proto__) would break a plain object.
// An entry that fails its check is replaced by a dropped marker, and handed back
// in rejected so its data can be kept aside, never sent.
// Numbers each item in conversation order, from the session's next number. A
// tool's end isn't numbered: it takes its tool's number when it's resolved.
export const numberItems = (items: TranscriptItem[], firstPosition: number): { items: NumberedItem[]; nextPosition: number } => {
  let nextPosition = firstPosition;
  const numbered = items.map((item): NumberedItem => (item.kind === "tool-end" ? item : ({ ...item, position: nextPosition++ } as NumberedItem)));
  return { items: numbered, nextPosition };
};

export const resolveTranscriptItems = (
  items: NumberedItem[],
  knownTools: ReadonlyMap<string, ToolEntry>,
): { entries: SessionEntry[]; knownTools: Map<string, ToolEntry>; rejected: SessionEntry[]; structuredCalls: { toolUseId: string; position: number }[] } => {
  const entries: SessionEntry[] = [];
  const structuredCalls: { toolUseId: string; position: number }[] = [];
  const stillRunning = new Map(knownTools);
  for (const item of items) {
    if (item.kind === "structured-call") {
      structuredCalls.push({ toolUseId: item.toolUseId, position: item.position });
    } else if (item.kind === "tool") {
      entries.push(item);
      // Only a tool that can be shown is tracked, and at most as many as a
      // session keeps, oldest dropped: tools that never end would otherwise grow
      // the session runner's memory for as long as the session writes them.
      if (readSessionEntry(item) === null) continue;
      stillRunning.set(item.entryId, item);
      const oldestToolId = stillRunning.keys().next().value;
      if (stillRunning.size > SESSION_LIMITS.maxEntriesKept && oldestToolId !== undefined) stillRunning.delete(oldestToolId);
    } else if (item.kind !== "tool-end") {
      entries.push(item);
    } else {
      const endedTool = stillRunning.get(item.toolUseId);
      if (!endedTool) continue;
      stillRunning.delete(item.toolUseId);
      entries.push({ ...endedTool, outcome: item.isFailed ? "failed" : "done" });
    }
  }
  const rejected = entries.filter((entry) => readSessionEntry(entry) === null);
  const checkedEntries = entries.map((entry) => readSessionEntry(entry) ?? toDroppedMarker(entry, "too long or malformed"));
  return { entries: capDroppedMarkers(checkedEntries, SESSION_LIMITS.maxDroppedPerBatch), knownTools: stillRunning, rejected, structuredCalls };
};

// A line Claude Code is still writing has no newline yet, so it waits for
// the next read.
export const readCompleteLines = (newBytes: Uint8Array): { lines: string[]; usedByteCount: number } => {
  const lastNewlineIndex = newBytes.lastIndexOf(NEWLINE_BYTE);
  if (lastNewlineIndex === -1) return { lines: [], usedByteCount: 0 };
  const completeText = new TextDecoder().decode(newBytes.subarray(0, lastNewlineIndex));
  return { lines: completeText.split("\n").filter((line) => line.trim()), usedByteCount: lastNewlineIndex + 1 };
};

// A session's transcript only legitimately rotates within its own project folder
// (a /clear or compaction starts a new file there). Following a switch anywhere
// else would let a self-authenticated hook point the session runner at an unrelated file to
// read and show as the session's conversation.
export const allowTranscriptSwitch = (newPath: string, currentPath: string | null): boolean =>
  currentPath === null || dirname(newPath) === dirname(currentPath);
