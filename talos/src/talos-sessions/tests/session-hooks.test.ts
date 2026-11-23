import { describe, expect, test } from "bun:test";
import { buildHookSettings, hookTokenAuthorized, isMainStopFailure } from "../claude/session-hooks";

test("buildHookSettings runs the hook command on every event", () => {
  const settings = JSON.parse(buildHookSettings('"/bin/bun" "/talos/hook.ts"', { TALOS_RUNNER_SOCKET: "/sock", TALOS_HOOK_TOKEN: "tok" }, "/home/uploads/s1"));
  expect(Object.keys(settings.hooks)).toEqual(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "StopFailure"]);
  expect(settings.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: '"/bin/bun" "/talos/hook.ts"' }] }]);
  // Pinned so a project's own disableAllHooks:true can't switch off enforcement,
  // nor its enabledPlugins turn talos's mod off.
  expect(settings.disableAllHooks).toBe(false);
  expect(settings.enabledPlugins).toEqual({ "talos@inline": true });
  // Claude may open the images a message names, from its own uploads only.
  expect(settings.permissions.allow).toEqual(["Read(//home/uploads/s1/**)"]);
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
    const { env } = JSON.parse(buildHookSettings("hook", {}, "/home/uploads/s1"));
    const pinned = ["BUN_OPTIONS", "NODE_OPTIONS", "BUN_INSPECT", "BUN_INSPECT_CONNECT_TO", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH"];
    expect(Object.fromEntries(pinned.map((name) => [name, env[name]]))).toEqual(Object.fromEntries(pinned.map((name) => [name, ""])));
  });
  test("an empty token never authorizes, even against an empty one", () => {
    expect(hookTokenAuthorized("", "")).toBe(false);
  });
});

test("a turn ended by an API error ends the session's turn, unless the failure was a sub-agent's", () => {
  expect(isMainStopFailure("StopFailure", { error: "rate_limit" })).toBe(true);
  expect(isMainStopFailure("StopFailure", { error: "rate_limit", agent_id: "a1" })).toBe(false);
});
