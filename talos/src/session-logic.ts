import { MAX_ENTRY_TEXT_LENGTH, parseJsonOrNull, type SessionEntry, type SessionState } from "talos-shared";
import { dirname } from "node:path";
import { MAX_TOOL_NAME_LENGTH, MAX_TOOL_SUMMARY_LENGTH, NEWLINE_BYTE } from "./constants";

// Claude Code's hook events that move a session between states. They also
// carry where the session's conversation is saved.
// PreToolUse and Stop also carry the status lane's decision back (see status-lane.ts).
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
// disableAllHooks is pinned false here because --settings outranks a project's
// own settings: without the pin, a session could write .claude/settings.local.json
// with disableAllHooks:true to switch off the whole enforcement layer for the
// next session in its folder.
// Env vars an on-disk `env` block could set to hijack the hook's interpreter so
// it exits before hook.ts runs — prepend bun/node args, inject a dylib, or attach
// a debugger. Pinned empty in --settings (which outranks project settings) so a
// session can't use them to make the hook self-disable and fail open. (A session
// as the same OS user can still tamper the interpreter itself — the same-uid
// residual behind #22; closing that needs separate uids.)
const PINNED_EMPTY_HOOK_ENV = {
  BUN_OPTIONS: "",
  NODE_OPTIONS: "",
  BUN_INSPECT: "",
  BUN_INSPECT_CONNECT_TO: "",
  DYLD_INSERT_LIBRARIES: "",
  DYLD_LIBRARY_PATH: "",
  LD_PRELOAD: "",
  LD_LIBRARY_PATH: "",
};

export const buildHookSettings = (hookCommand: string, hookEnv: Record<string, string>): string => {
  const commandHook = [{ hooks: [{ type: "command", command: hookCommand }] }];
  // Pin `env` too: --settings outranks a project's own settings, so a session
  // can't write .claude/settings.local.json with an `env` block that blanks the
  // socket/token the hook reads, or hijacks its interpreter — either of which
  // would make the hook self-disable and the enforcement fail open.
  return JSON.stringify({
    disableAllHooks: false,
    env: { ...PINNED_EMPTY_HOOK_ENV, ...hookEnv },
    hooks: Object.fromEntries(HOOK_EVENTS.map((hookEvent) => [hookEvent, commandHook])),
  });
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

// Keys from an attached terminal that start the next turn: Enter sends a
// message, and Esc or Ctrl-C interrupts. Arrow keys, scrolling and other escape
// sequences don't, so they mustn't end a running status turn.
const ENTER_BYTE = 0x0d;
const ESC_BYTE = 0x1b;
const CTRL_C_BYTE = 0x03;
// Esc and Ctrl-C as a terminal sends them once Claude Code turns on kitty or
// modifyOtherKeys key encoding.
const ENCODED_INTERRUPT_KEYS = ["\x1b[27u", "\x1b[99;5u", "\x1b[27;5;99~"];
export const isTurnChangingKeys = (keys: Uint8Array): boolean => {
  const isOnlyEsc = keys.length > 0 && keys.every((byte) => byte === ESC_BYTE);
  const keysText = new TextDecoder().decode(keys);
  const hasEncodedInterrupt = ENCODED_INTERRUPT_KEYS.some((sequence) => keysText.includes(sequence));
  return keys.includes(ENTER_BYTE) || keys.includes(CTRL_C_BYTE) || isOnlyEsc || hasEncodedInterrupt;
};

// Keys that type into the draft. Arrow keys and the reports a terminal sends on
// its own (focus in or out, cursor position) all start with Esc, so they don't.
// shortcut: Up recalling an old message also starts with Esc and is missed;
// upgrade once the host tracks unsent drafts.
export const isDraftChangingKeys = (keys: Uint8Array): boolean => keys.length > 0 && keys[0] !== ESC_BYTE;

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
// Returns the entries to send and the tools still known. Builds its result by
// mutating local copies rather than spreading the accumulator each item: the
// spread version was O(n^2), so one large transcript read (e.g. a resumed
// session's whole file) could block the single-threaded host for seconds.
export const resolveTranscriptItems = (
  items: TranscriptItem[],
  knownTools: Record<string, ToolEntry>,
): { entries: SessionEntry[]; knownTools: Record<string, ToolEntry> } => {
  const entries: SessionEntry[] = [];
  const stillRunning: Record<string, ToolEntry> = { ...knownTools };
  for (const item of items) {
    if (item.kind === "tool") {
      entries.push(item);
      stillRunning[item.entryId] = item;
    } else if (item.kind !== "tool-end") {
      entries.push(item);
    } else {
      const endedTool = stillRunning[item.toolUseId];
      if (!endedTool) continue;
      delete stillRunning[item.toolUseId];
      entries.push({ ...endedTool, outcome: item.isFailed ? "failed" : "done" });
    }
  }
  return { entries, knownTools: stillRunning };
};

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

// Every session on a machine shares one hooks socket, so a hook POST must prove
// which session it is: the host checks the token it sent against the named
// session's token. A session knows only its own token, so it can't drive another
// session's hooks by naming it in the path.
export const hookTokenAuthorized = (provided: string | null, expected: string | undefined): boolean =>
  typeof provided === "string" && provided.length > 0 && provided === expected;

// Collapses rapid calls into one run per window (trailing edge): a burst becomes
// a single run that reads the latest state itself, so nothing is lost, only
// coalesced. Used to debounce the host's session broadcast so a session can't
// flood the uplink by flapping its own state. `schedule` is injectable for tests.
export const createCoalescer = (
  run: () => void,
  windowMs: number,
  schedule: (fn: () => void, ms: number) => unknown = setTimeout,
): (() => void) => {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    schedule(() => {
      pending = false;
      run();
    }, windowMs);
  };
};

// A session's transcript only legitimately rotates within its own project folder
// (a /clear or compaction starts a new file there). Following a switch anywhere
// else would let a self-authenticated hook point the host at an unrelated file to
// read and show as the session's conversation.
export const allowTranscriptSwitch = (newPath: string, currentPath: string | null): boolean =>
  currentPath === null || dirname(newPath) === dirname(currentPath);
