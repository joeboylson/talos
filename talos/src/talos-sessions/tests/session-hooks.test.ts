import { describe, expect, test } from "bun:test";
import { buildHookSettings, hookTokenAuthorized, nextSessionState } from "../claude/session-hooks";

describe("nextSessionState", () => {
  test.each([
    ["SessionStart", {}, null],
    ["Stop", {}, "idle"],
    ["UserPromptSubmit", {}, "working"],
    ["PostToolUse", {}, "working"],
    ["Notification", { message: "Claude needs your permission to use Bash" }, "needs-you"],
    ["Notification", { notification_type: "permission_prompt" }, "needs-you"],
    ["Notification", { notification_type: "idle_prompt" }, null],
    ["Notification", { message: "Claude is waiting for your input" }, null],
    ["SessionEnd", {}, null],
  ] as const)("%s %p → %p", (hookEvent, payload, expected) => {
    expect(nextSessionState(hookEvent, payload)).toBe(expected);
  });
});

test("buildHookSettings runs the hook command on every event", () => {
  const settings = JSON.parse(buildHookSettings('"/bin/bun" "/talos/hook.ts"', { TALOS_RUNNER_SOCKET: "/sock", TALOS_HOOK_TOKEN: "tok" }));
  expect(Object.keys(settings.hooks)).toEqual(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Notification", "Stop", "StopFailure"]);
  expect(settings.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: '"/bin/bun" "/talos/hook.ts"' }] }]);
  // Pinned so a project's own disableAllHooks:true can't switch off enforcement.
  expect(settings.disableAllHooks).toBe(false);
  // Pinned so a project's own `env` can't blank the socket/token the hook reads.
  expect(settings.env.TALOS_RUNNER_SOCKET).toBe("/sock");
  expect(settings.env.TALOS_HOOK_TOKEN).toBe("tok");
  // Interpreter/loader-hijack vars pinned empty so a project can't run e.g.
  // `bun --version hook.ts` (exit before the hook) or inject a dylib.
  expect(settings.env.BUN_OPTIONS).toBe("");
  expect(settings.env.DYLD_INSERT_LIBRARIES).toBe("");
});

describe("hookTokenAuthorized", () => {
  test.each([
    ["the token matches", "tok-abc", "tok-abc", true],
    ["the token differs (another session)", "tok-victim", "tok-mine", false],
    ["no token header", null, "tok-abc", false],
    ["an empty token", "", "tok-abc", false],
    ["the session has no token", "tok-abc", undefined, false],
  ])("%s → %p", (_name, provided, expected, result) => {
    expect(hookTokenAuthorized(provided as string | null, expected as string | undefined)).toBe(result);
  });
});

describe("hook edges", () => {
  test("every interpreter and loader variable is pinned empty", () => {
    const { env } = JSON.parse(buildHookSettings("hook", {}));
    const pinned = ["BUN_OPTIONS", "NODE_OPTIONS", "BUN_INSPECT", "BUN_INSPECT_CONNECT_TO", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH"];
    expect(Object.fromEntries(pinned.map((name) => [name, env[name]]))).toEqual(Object.fromEntries(pinned.map((name) => [name, ""])));
  });
  test("an empty token never authorizes, even against an empty one", () => {
    expect(hookTokenAuthorized("", "")).toBe(false);
  });
  test("a Notification with no body needs the person", () => {
    expect(nextSessionState("Notification", null)).toBe("needs-you");
  });
});

test("a turn ended by an API error is idle, unless the failure was a sub-agent's", () => {
  expect(nextSessionState("StopFailure", { error: "rate_limit" })).toBe("idle");
  expect(nextSessionState("StopFailure", { error: "rate_limit", agent_id: "a1" })).toBeNull();
});
