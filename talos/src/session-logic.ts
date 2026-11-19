import {
  MAX_ENTRY_TEXT_LENGTH,
  MAX_STATUS_NOTE_LENGTH,
  REPORTED_STATUSES,
  parseJsonOrNull,
  type ReportedStatus,
  type SessionEntry,
  type SessionState,
} from "talos-shared";
import { dirname } from "node:path";
import { MAX_TOOL_NAME_LENGTH, MAX_TOOL_SUMMARY_LENGTH, NEWLINE_BYTE, STATUS_TOOL_NAME } from "./constants";

// Claude Code's hook events that move a session between states. They also
// carry where the session's conversation is saved.
// PreToolUse and Stop also carry a decision back (the status lane: force the
// report_status call, and keep a status turn to that one tool).
export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

// Claude Code sends this notification after a minute of waiting for a message.
// That's just being idle, not a question for the person.
const IDLE_NOTIFICATION_TYPE = "idle_prompt";
const IDLE_NOTIFICATION_TEXT = "waiting for your input";

// SessionStart isn't "ready": Claude Code sends it before its input box can
// take typing. The host waits for the screen to settle instead.
export const nextSessionState = (hookEvent: string, hookPayload: unknown): SessionState | null => {
  if (hookEvent === "Stop") return "idle";
  if (hookEvent === "UserPromptSubmit" || hookEvent === "PostToolUse") return "working";
  if (hookEvent !== "Notification") return null;
  const isObject = typeof hookPayload === "object" && hookPayload !== null;
  const notificationType: unknown = isObject ? Reflect.get(hookPayload, "notification_type") : undefined;
  const notificationText: unknown = isObject ? Reflect.get(hookPayload, "message") : undefined;
  const isIdleNotification =
    notificationType === IDLE_NOTIFICATION_TYPE ||
    (typeof notificationText === "string" && notificationText.includes(IDLE_NOTIFICATION_TEXT));
  return isIdleNotification ? null : "needs-you";
};

// The --settings value that makes Claude Code run talos's hook script on
// each event. It adds to the person's own settings rather than replacing them.
export const buildHookSettings = (hookCommand: string): string => {
  const commandHook = [{ hooks: [{ type: "command", command: hookCommand }] }];
  return JSON.stringify({ hooks: Object.fromEntries(HOOK_EVENTS.map((hookEvent) => [hookEvent, commandHook])) });
};

// Bracketed paste: Claude Code takes the whole text as one message, even with
// line breaks, instead of sending at the first one. Enter then sends it.
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
export const ENTER_KEY = "\r";
export const buildPastedText = (text: string): string => `${PASTE_START}${removeControlCharacters(text)}${PASTE_END}`;

// Control characters would act as keys in Claude Code instead of text: one
// escape sequence ends the paste early and the rest gets typed as keystrokes
// (Enter, answers to permission prompts). Only line breaks and tabs stay.
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
export const removeControlCharacters = (text: string): string => text.replace(CONTROL_CHARACTERS, "");

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
const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
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
export const readCommandPrompt = (text: string): string | null => {
  const commandName = COMMAND_NAME.exec(text)?.[1]?.trim();
  if (!commandName) return null;
  const commandArgs = COMMAND_ARGS.exec(text)?.[1]?.trim() ?? "";
  return `${commandName} ${commandArgs}`.trim();
};

const TOOL_SUMMARY_FIELDS = ["description", "command", "file_path", "path", "pattern", "url", "query", "skill", "prompt"];

// One line saying what a tool is doing, from its most telling input.
export const summarizeToolInput = (input: unknown): string => {
  if (typeof input !== "object" || input === null) return "";
  const firstTellingValue = TOOL_SUMMARY_FIELDS.map((field) => Reflect.get(input, field)).find(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  return truncate((firstTellingValue ?? "").replace(/\s+/g, " ").trim(), MAX_TOOL_SUMMARY_LENGTH);
};

const readPromptLine = (entryId: string, blocks: ContentBlock[]): SessionEntry[] => {
  const typedText = blocks.flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : [])).join("\n");
  const imageCount = blocks.filter((block) => block.type === "image").length;
  const isNote = NOTE_PREFIXES.some((prefix) => typedText.trimStart().startsWith(prefix));
  if (isNote) return [];

  const commandOutput = COMMAND_OUTPUT.exec(typedText.trim())?.[1]?.trim();
  if (commandOutput !== undefined) {
    return commandOutput ? [{ kind: "text", entryId, text: truncate(commandOutput, MAX_ENTRY_TEXT_LENGTH) }] : [];
  }

  const promptText = (readCommandPrompt(typedText) ?? typedText.replace(IMAGE_MARKER, "")).trim();
  if (!promptText && imageCount === 0) return [];
  return [{ kind: "prompt", entryId, text: truncate(promptText, MAX_ENTRY_TEXT_LENGTH), imageCount }];
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
      return [{ kind: "text", entryId: `${lineId}:${blockIndex}`, text: truncate(block.text, MAX_ENTRY_TEXT_LENGTH) }];
    }
    if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      const toolName = truncate(block.name, MAX_TOOL_NAME_LENGTH);
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
// Returns the entries to send and the tools still known.
export const resolveTranscriptItems = (
  items: TranscriptItem[],
  knownTools: Record<string, ToolEntry>,
): { entries: SessionEntry[]; knownTools: Record<string, ToolEntry> } =>
  items.reduce(
    (result, item) => {
      if (item.kind === "tool") {
        return { entries: [...result.entries, item], knownTools: { ...result.knownTools, [item.entryId]: item } };
      }
      if (item.kind !== "tool-end") return { ...result, entries: [...result.entries, item] };
      const endedTool = result.knownTools[item.toolUseId];
      if (!endedTool) return result;
      const { [item.toolUseId]: _endedTool, ...stillRunning } = result.knownTools;
      const outcome = item.isFailed ? "failed" : "done";
      return { entries: [...result.entries, { ...endedTool, outcome }], knownTools: stillRunning };
    },
    { entries: [] as SessionEntry[], knownTools },
  );

// A line Claude Code is still writing has no newline yet, so it waits for
// the next read.
export const readCompleteLines = (newBytes: Uint8Array): { lines: string[]; usedByteCount: number } => {
  const lastNewlineIndex = newBytes.lastIndexOf(NEWLINE_BYTE);
  if (lastNewlineIndex === -1) return { lines: [], usedByteCount: 0 };
  const completeText = new TextDecoder().decode(newBytes.subarray(0, lastNewlineIndex));
  return { lines: completeText.split("\n").filter((line) => line.trim()), usedByteCount: lastNewlineIndex + 1 };
};

// The message typed into Claude Code: the text, then each image's saved path.
// Claude Code turns a pasted image path into an attached image.
export const buildMessageWithImages = (text: string, imagePaths: string[]): string =>
  [text.trim(), ...imagePaths].filter(Boolean).join("\n\n");

// Claude Code marks the sessions it runs, and a session started with these
// marks thinks it's a sub-session: it stops saving its conversation (which
// the replies are read from). talos may itself run inside Claude Code, so
// the marks are dropped. The rest of the environment, including the
// person's own Claude Code settings, is kept.
const INHERITED_SESSION_MARKS = [
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SSE_PORT",
];

export const buildSessionEnv = (
  env: Record<string, string | undefined>,
  sessionVariables: Record<string, string>,
): Record<string, string | undefined> => {
  const keptEntries = Object.entries(env).filter(([envKey]) => !INHERITED_SESSION_MARKS.includes(envKey));
  return { ...Object.fromEntries(keptEntries), ...sessionVariables };
};

// Keeps the most recent output, so someone attaching sees the current screen.
export const appendOutput = (output: Uint8Array, chunk: Uint8Array, maxBytes: number): Uint8Array => {
  const combined = new Uint8Array(output.length + chunk.length);
  combined.set(output);
  combined.set(chunk, output.length);
  return combined.length > maxBytes ? combined.slice(combined.length - maxBytes) : combined;
};


// What the host asks a session to do for a status update. The session answers
// by calling report_status (the PreToolUse hook forces it to be the only tool).
export const STATUS_REQUEST_PROMPT =
  "Give a status update on this session by calling report_status once, with your state and one short line. Do not do anything else.";

// The tool a PreToolUse hook is about to run, from its payload.
export const readHookToolName = (hookPayload: unknown): string =>
  typeof hookPayload === "object" && hookPayload !== null ? String(Reflect.get(hookPayload, "tool_name") ?? "") : "";

// Whether a Stop hook is itself a continuation forced by an earlier Stop block,
// so the host doesn't force the report_status call forever.
export const isStopContinuation = (hookPayload: unknown): boolean =>
  typeof hookPayload === "object" && hookPayload !== null && Reflect.get(hookPayload, "stop_hook_active") === true;

// A PreToolUse decision Claude Code honors: allow runs the tool with no prompt,
// deny blocks it and tells the model why. Returned as the hook's stdout.
export const allowToolDecision = (): string =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });
export const denyToolDecision = (reason: string): string =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

// A Stop decision: block keeps the turn going with a reason, so the session
// can't finish until it has reported.
export const blockStopDecision = (reason: string): string => JSON.stringify({ decision: "block", reason });

// Every session on a machine shares one hooks socket, so a hook POST must prove
// which session it is: the host checks the token it sent against the named
// session's token. A session knows only its own token, so it can't drive another
// session's hooks by naming it in the path.
export const hookTokenAuthorized = (provided: string | null, expected: string | undefined): boolean =>
  typeof provided === "string" && provided.length > 0 && provided === expected;

// A session's transcript only legitimately rotates within its own project folder
// (a /clear or compaction starts a new file there). Following a switch anywhere
// else would let a self-authenticated hook point the host at an unrelated file to
// read and show as the session's conversation.
export const allowTranscriptSwitch = (newPath: string, currentPath: string | null): boolean =>
  currentPath === null || dirname(newPath) === dirname(currentPath);

type ReportedStatusUpdate = { state: ReportedStatus; note: string };

// A status note is one short line that lands in the sessions table and the
// logs, so strip control characters (an ANSI escape, a stray newline) and
// collapse whitespace: the session shouldn't be able to put terminal escapes in
// a shared row or split a log line through its note.
const cleanStatusNote = (note: string): string => removeControlCharacters(note).replace(/\s+/g, " ").trim();

// The report_status call in one transcript line, if any: the state and note the
// session reported. Read from the saved conversation, so the shape isn't trusted.
// The last valid call in the line wins, matching the host's cross-line harvest
// (each report overwrites the one before), so reporting twice ends on the final
// answer.
export const readStatusReport = (lineText: string): ReportedStatusUpdate | null => {
  const line: unknown = parseJsonOrNull(lineText);
  if (typeof line !== "object" || line === null || Reflect.get(line, "type") !== "assistant") return null;
  // A status is this session's own answer, so skip Claude Code's own notes
  // (isMeta) and a sub-agent's lines (isSidechain) — same as readTranscriptLine —
  // or a sub-agent could report a status for the session it runs under.
  if (Reflect.get(line, "isMeta") === true || Reflect.get(line, "isSidechain") === true) return null;
  const content = (line as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return null;
  let latest: ReportedStatusUpdate | null = null;
  for (const block of content) {
    const isCall = typeof block === "object" && block !== null && block.type === "tool_use" && block.name === STATUS_TOOL_NAME;
    const input: unknown = isCall ? block.input : null;
    const state = typeof input === "object" && input !== null ? Reflect.get(input, "state") : null;
    const note = typeof input === "object" && input !== null ? Reflect.get(input, "note") : null;
    const isValid = REPORTED_STATUSES.some((s) => s === state) && typeof note === "string" && note.length <= MAX_STATUS_NOTE_LENGTH;
    if (isValid) latest = { state: state as ReportedStatus, note: cleanStatusNote(note as string) };
  }
  return latest;
};

// The report_status calls in a freshly-read transcript slice, in order, counting
// ONLY lines whose absolute byte start is at/after `fromByte` — the file size
// when the status turn began. A report_status left in the backlog by an earlier
// turn (a chat-turn call the hook denied, whose tool_use input still lands in the
// transcript) or by a sub-agent would otherwise be harvested as this turn's
// status; the floor keeps the harvest to lines the session wrote this turn.
// `sliceStart` is the slice's own byte offset in the file; `sliceBytes` holds
// only complete lines (as readCompleteLines returns).
export const readStatusReportsInSlice = (sliceBytes: Uint8Array, sliceStart: number, fromByte: number): ReportedStatusUpdate[] => {
  const reports: ReportedStatusUpdate[] = [];
  const decoder = new TextDecoder();
  let lineFrom = 0;
  for (let i = 0; i < sliceBytes.length; i++) {
    if (sliceBytes[i] !== NEWLINE_BYTE) continue;
    if (sliceStart + lineFrom >= fromByte) {
      const report = readStatusReport(decoder.decode(sliceBytes.subarray(lineFrom, i)));
      if (report) reports.push(report);
    }
    lineFrom = i + 1;
  }
  return reports;
};
