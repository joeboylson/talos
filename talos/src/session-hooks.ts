import type { SessionState } from "talos-shared";

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

// Every session on a machine shares one hooks socket, so a hook request must prove
// which session it is: the host checks the token it sent against the named
// session's token. A session knows only its own token, so it can't drive another
// session's hooks by naming it in the path.
export const hookTokenAuthorized = (provided: string | null, expected: string | undefined): boolean =>
  typeof provided === "string" && provided.length > 0 && provided === expected;
