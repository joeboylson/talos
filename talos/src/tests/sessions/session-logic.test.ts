import { describe, expect, test } from "bun:test";
import {
  appendOutput,
  buildSessionEnv,
  buildHookSettings,
  buildTypedMessage,
  nextSessionState,
  readLastExchange,
} from "../../session-logic";

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
  const settings = JSON.parse(buildHookSettings('"/bin/bun" "/talos/hook.ts"'));
  expect(Object.keys(settings.hooks)).toEqual(["SessionStart", "UserPromptSubmit", "PostToolUse", "Notification", "Stop"]);
  expect(settings.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: '"/bin/bun" "/talos/hook.ts"' }] }]);
});

test("buildTypedMessage pastes the whole text, then presses Enter", () => {
  expect(buildTypedMessage("line one\nline two")).toBe("\x1b[200~line one\nline two\x1b[201~\r");
});

describe("readLastExchange", () => {
  const line = (entry: unknown) => JSON.stringify(entry);
  const transcript = [
    line({ type: "user", message: { role: "user", content: "first question" } }),
    line({ type: "assistant", message: { content: [{ type: "text", text: "first answer" }] } }),
    line({ type: "user", message: { role: "user", content: [{ type: "text", text: "fix the login" }] } }),
    line({ type: "assistant", message: { content: [{ type: "text", text: "Looking." }, { type: "tool_use", name: "Read" }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", content: "file text" }] } }),
    line({ type: "user", isMeta: true, message: { content: "a note Claude Code added" } }),
    line({ type: "assistant", message: { content: [{ type: "text", text: "Fixed it." }] } }),
    "not json",
    "",
  ].join("\n");

  test("finds the last message someone sent and all of Claude's text after it", () => {
    expect(readLastExchange(transcript, 5)).toEqual({ prompt: "fix the login", reply: "Looking.\n\nFixed it.", finishedAtMs: 5 });
  });

  test("an empty conversation has no exchange", () => {
    expect(readLastExchange("", 5)).toBeNull();
  });

  test("a message with no answer yet has an empty reply", () => {
    expect(readLastExchange(line({ type: "user", message: { content: "hi" } }), 5)).toEqual({
      prompt: "hi",
      reply: "",
      finishedAtMs: 5,
    });
  });
});

test("buildSessionEnv drops Claude Code's own session marks and keeps everything else", () => {
  const env = { PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_EFFORT: "high" };
  expect(buildSessionEnv(env, { TALOS_SESSION_NAME: "fix" })).toEqual({
    PATH: "/bin",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_EFFORT: "high",
    TALOS_SESSION_NAME: "fix",
  });
});

test("appendOutput keeps only the most recent bytes", () => {
  const output = appendOutput(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), 4);
  expect([...output]).toEqual([2, 3, 4, 5]);
  expect([...appendOutput(new Uint8Array(), new Uint8Array([1]), 4)]).toEqual([1]);
});
