import { MOD_PLUGIN_ID } from "../constants";

// The Claude Code hook events talos's lanes and outputs read (see lanes/).
// The session's state comes from its mod's facts instead (link/fact-state.ts).
// SessionStart also carries where the session's conversation is saved.
// StopFailure comes instead of Stop when a turn ends on an API error (a rate
// limit, an overload); it can't be blocked.
export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "StopFailure"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

// A sub-agent's hook carries agent_id. Its failure isn't the session's turn.
const isSubagentHook = (hookPayload: unknown): boolean =>
  typeof hookPayload === "object" && hookPayload !== null && typeof Reflect.get(hookPayload, "agent_id") === "string";
export const isMainStopFailure = (hookEvent: unknown, hookPayload: unknown): boolean => hookEvent === "StopFailure" && !isSubagentHook(hookPayload);

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

// Messages name their images by path (talos's mod can't attach them), so
// Claude may read the session's uploads folder, and nothing around it (the
// home also holds the runner's sockets). `//` starts an absolute path in a rule.
export const buildHookSettings = (hookCommand: string, hookEnv: Record<string, string>, uploadsFolder: string): string => {
  const commandHook = [{ hooks: [{ type: "command", command: hookCommand }] }];
  // Pin `env` too: --settings outranks a project's own settings, so a session
  // can't write .claude/settings.local.json with an `env` block that blanks the
  // socket/token the hook reads, or hijacks its interpreter — either of which
  // would make the hook self-disable and the enforcement fail open.
  // enabledPlugins too: a project's settings can't turn talos's mod off.
  return JSON.stringify({
    disableAllHooks: false,
    enabledPlugins: { [MOD_PLUGIN_ID]: true },
    permissions: { allow: [`Read(/${uploadsFolder}/**)`] },
    env: { ...PINNED_EMPTY_HOOK_ENV, ...hookEnv },
    hooks: Object.fromEntries(HOOK_EVENTS.map((hookEvent) => [hookEvent, commandHook])),
  });
};

// Every session on a machine shares one hooks socket, so a hook request must prove
// which session it is: the session runner checks the token it sent against the named
// session's token. A session knows only its own token, so it can't drive another
// session's hooks by naming it in the path.
export const hookTokenAuthorized = (provided: string | null, expected: string | undefined): boolean =>
  typeof provided === "string" && provided.length > 0 && provided === expected;
