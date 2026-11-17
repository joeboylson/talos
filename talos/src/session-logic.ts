import { parseJsonOrNull, type Exchange, type SessionState } from "talos-shared";

// Claude Code's hook events that move a session between states. Stop is
// also when the finished exchange is read and sent to the page.
export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Notification", "Stop"] as const;
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
const ENTER = "\r";
export const buildTypedMessage = (text: string): string => `${PASTE_START}${text}${PASTE_END}${ENTER}`;

type TranscriptEntry = { type?: unknown; isMeta?: unknown; message?: { content?: unknown } };

const readTextBlocks = (content: unknown): string[] => {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) =>
    typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
  );
};

// A message someone sent, as opposed to tool results Claude Code also files
// under "user", or notes it adds itself.
const isPrompt = (entry: TranscriptEntry): boolean =>
  entry.type === "user" && entry.isMeta !== true && readTextBlocks(entry.message?.content).length > 0;

// The last message in a saved conversation (Claude Code's .jsonl transcript)
// and everything Claude wrote after it.
export const readLastExchange = (transcriptText: string, finishedAtMs: number): Exchange | null => {
  const entries = transcriptText
    .split("\n")
    .map((line) => parseJsonOrNull(line))
    .filter((entry): entry is TranscriptEntry => typeof entry === "object" && entry !== null);
  const lastPromptIndex = entries.findLastIndex(isPrompt);
  if (lastPromptIndex === -1) return null;

  const prompt = readTextBlocks(entries[lastPromptIndex]?.message?.content).join("\n");
  const reply = entries
    .slice(lastPromptIndex + 1)
    .filter((entry) => entry.type === "assistant")
    .flatMap((entry) => readTextBlocks(entry.message?.content))
    .join("\n\n");
  return { prompt, reply, finishedAtMs };
};

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
