import { dirname } from "node:path";
import { parseJsonOrNull } from "../json";
import { SESSION_LIMITS } from "../limits";
import { capDroppedMarkers, readSessionEntry, toDroppedMarker, type SessionEntry } from "../shapes";
import { TOOL_SUMMARY_SHOWN_LENGTH, NEWLINE_BYTE } from "../constants";

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

// What one transcript line holds: entries, and tools that ended (their
// results are saved as separate lines, after the tool's own line).
export type TranscriptItem = SessionEntry | { kind: "tool-end"; toolUseId: string; isFailed: boolean };

const IMAGE_MARKER = /\[Image #\d+\]/g;
const COMMAND_OUTPUT = /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/;
// Claude Code's own notes, saved as messages, that nobody typed.
const NOTE_PREFIXES = ["<local-command-caveat>", "<system-reminder>", "<bash-stdout>", "<bash-stderr>"];

const truncate = (text: string, maxLength: number): string => (text.length > maxLength ? text.slice(0, maxLength) : text);

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

const readPromptLine = (entryId: string, blocks: ContentBlock[]): SessionEntry[] => {
  const typedText = blocks.flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : [])).join("\n");
  const imageCount = blocks.filter((block) => block.type === "image").length;
  const isNote = NOTE_PREFIXES.some((prefix) => typedText.trimStart().startsWith(prefix));
  if (isNote) return [];

  const commandOutput = COMMAND_OUTPUT.exec(typedText.trim())?.[1]?.trim();
  if (commandOutput !== undefined) {
    return commandOutput ? [{ kind: "text", entryId, text: truncate(commandOutput, SESSION_LIMITS.maxEntryTextLength) }] : [];
  }

  const promptText = (readCommandPrompt(typedText) ?? typedText.replace(IMAGE_MARKER, "")).trim();
  if (!promptText && imageCount === 0) return [];
  return [{ kind: "prompt", entryId, text: truncate(promptText, SESSION_LIMITS.maxEntryTextLength), imageCount }];
};

const readToolEnds = (blocks: ContentBlock[]): TranscriptItem[] =>
  blocks.flatMap((block) =>
    block.type === "tool_result" && typeof block.tool_use_id === "string"
      ? [{ kind: "tool-end" as const, toolUseId: block.tool_use_id, isFailed: block.is_error === true }]
      : [],
  );

const readAssistantLine = (lineId: string, blocks: ContentBlock[]): SessionEntry[] =>
  blocks.flatMap((block, blockIndex): SessionEntry[] => {
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      return [{ kind: "text", entryId: `${lineId}:${blockIndex}`, text: truncate(block.text, SESSION_LIMITS.maxEntryTextLength) }];
    }
    if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      const toolName = truncate(block.name, SESSION_LIMITS.maxNameTextLength);
      return [{ kind: "tool", entryId: block.id, toolName, summary: summarizeToolInput(block.input), outcome: "running" }];
    }
    return [];
  });

// Skips Claude's thinking, notes Claude Code adds itself (like a skill's
// instructions), and sub-agents' own conversations.
export const readTranscriptLine = (lineText: string): TranscriptItem[] => {
  const line: unknown = parseJsonOrNull(lineText);
  if (typeof line !== "object" || line === null) return [];
  const { type, uuid, isMeta, isSidechain, message } = line as TranscriptLine;
  if (typeof uuid !== "string" || isMeta === true || isSidechain === true) return [];
  const blocks = contentBlocksOf(message?.content);
  if (type === "assistant") return readAssistantLine(uuid, blocks);
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
export const resolveTranscriptItems = (
  items: TranscriptItem[],
  knownTools: ReadonlyMap<string, ToolEntry>,
): { entries: SessionEntry[]; knownTools: Map<string, ToolEntry>; rejected: SessionEntry[] } => {
  const entries: SessionEntry[] = [];
  const stillRunning = new Map(knownTools);
  for (const item of items) {
    if (item.kind === "tool") {
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
  return { entries: capDroppedMarkers(checkedEntries, SESSION_LIMITS.maxDroppedPerBatch), knownTools: stillRunning, rejected };
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
