import { describe, expect, test } from "bun:test";
import {
  appendOutput,
  buildSessionEnv,
  buildHookSettings,
  buildMessageWithImages,
  buildPastedText,
  nextSessionState,
  readCommandPrompt,
  readCompleteLines,
  removeControlCharacters,
  readTranscriptLine,
  resolveTranscriptItems,
  summarizeToolInput,
  createCoalescer,
  hookTokenAuthorized,
  isDraftChangingKeys,
  isTurnChangingKeys,
  allowTranscriptSwitch,
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
  const settings = JSON.parse(buildHookSettings('"/bin/bun" "/talos/hook.ts"', { TALOS_HOST_SOCKET: "/sock", TALOS_HOOK_TOKEN: "tok" }));
  expect(Object.keys(settings.hooks)).toEqual(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop"]);
  expect(settings.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: '"/bin/bun" "/talos/hook.ts"' }] }]);
  // Pinned so a project's own disableAllHooks:true can't switch off enforcement.
  expect(settings.disableAllHooks).toBe(false);
  // Pinned so a project's own `env` can't blank the socket/token the hook reads.
  expect(settings.env.TALOS_HOST_SOCKET).toBe("/sock");
  expect(settings.env.TALOS_HOOK_TOKEN).toBe("tok");
  // Interpreter/loader-hijack vars pinned empty so a project can't run e.g.
  // `bun --version hook.ts` (exit before the hook) or inject a dylib.
  expect(settings.env.BUN_OPTIONS).toBe("");
  expect(settings.env.DYLD_INSERT_LIBRARIES).toBe("");
});

test("buildPastedText pastes the whole text as one piece", () => {
  expect(buildPastedText("line one\nline two")).toBe("\x1b[200~line one\nline two\x1b[201~");
});

describe("readTranscriptLine", () => {
  const line = (entry: object) => JSON.stringify({ uuid: "u1", ...entry });

  test("a typed message is a prompt", () => {
    expect(readTranscriptLine(line({ type: "user", message: { content: "fix the login" } }))).toEqual([
      { kind: "prompt", entryId: "u1", text: "fix the login", imageCount: 0 },
    ]);
  });

  test("a slash command shows the way it was typed", () => {
    const content = "<command-message>s</command-message>\n<command-name>/s</command-name>\n<command-args>anything to commit?</command-args>";
    expect(readTranscriptLine(line({ type: "user", message: { content } }))).toEqual([
      { kind: "prompt", entryId: "u1", text: "/s anything to commit?", imageCount: 0 },
    ]);
  });

  test("attached images are counted, and their markers dropped", () => {
    const content = [
      { type: "text", text: "[Image #1]What's this?" },
      { type: "image", source: { type: "base64", data: "AAAA" } },
    ];
    expect(readTranscriptLine(line({ type: "user", message: { content } }))).toEqual([
      { kind: "prompt", entryId: "u1", text: "What's this?", imageCount: 1 },
    ]);
  });

  test("Claude's text and tools are entries, one per block; thinking isn't", () => {
    const content = [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "Looking." },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "git   status", description: "Show status" } },
    ];
    expect(readTranscriptLine(line({ type: "assistant", message: { content } }))).toEqual([
      { kind: "text", entryId: "u1:1", text: "Looking." },
      { kind: "tool", entryId: "t1", toolName: "Bash", summary: "Show status", outcome: "running" },
    ]);
  });

  test("a tool's result says it ended", () => {
    const content = [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "boom" }];
    expect(readTranscriptLine(line({ type: "user", message: { content } }))).toEqual([
      { kind: "tool-end", toolUseId: "t1", isFailed: true },
    ]);
  });

  test("a built-in command's output is text", () => {
    const content = "<local-command-stdout>Compacted</local-command-stdout>";
    expect(readTranscriptLine(line({ type: "user", message: { content } }))).toEqual([
      { kind: "text", entryId: "u1", text: "Compacted" },
    ]);
  });

  test.each([
    ["a skill's instructions", line({ type: "user", isMeta: true, message: { content: "Base directory for this skill" } })],
    ["a sub-agent's work", line({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "hi" }] } })],
    ["Claude Code's own notes", line({ type: "user", message: { content: "<local-command-caveat>Caveat</local-command-caveat>" } })],
    ["other kinds of line", line({ type: "file-history-snapshot" })],
    ["a line with no id", JSON.stringify({ type: "user", message: { content: "hi" } })],
    ["not JSON", "not json"],
  ])("skips %s", (_name, lineText) => {
    expect(readTranscriptLine(lineText)).toEqual([]);
  });
});

describe("resolveTranscriptItems", () => {
  const running = { kind: "tool", entryId: "t1", toolName: "Bash", summary: "ls", outcome: "running" } as const;

  test("a tool's end sends the tool again with how it went", () => {
    const { entries, knownTools } = resolveTranscriptItems([{ kind: "tool-end", toolUseId: "t1", isFailed: false }], {
      t1: running,
    });
    expect(entries).toEqual([{ ...running, outcome: "done" }]);
    expect(knownTools).toEqual({});
  });

  test("a tool started and ended in the same read", () => {
    const { entries } = resolveTranscriptItems([running, { kind: "tool-end", toolUseId: "t1", isFailed: true }], {});
    expect(entries).toEqual([running, { ...running, outcome: "failed" }]);
  });

  test("an unknown tool's end is dropped", () => {
    expect(resolveTranscriptItems([{ kind: "tool-end", toolUseId: "zz", isFailed: false }], {}).entries).toEqual([]);
  });

  test("doesn't mutate the knownTools it was given", () => {
    const knownTools = { t1: running };
    resolveTranscriptItems([{ kind: "tool-end", toolUseId: "t1", isFailed: false }], knownTools);
    expect(knownTools).toEqual({ t1: running });
  });

  test("stays linear on a large read (would be seconds if quadratic)", () => {
    const items = Array.from({ length: 50_000 }, (_unused, i) => ({ kind: "text" as const, entryId: `e${i}`, text: "x" }));
    const startMs = Date.now();
    const { entries } = resolveTranscriptItems(items, {});
    expect(entries.length).toBe(50_000);
    expect(Date.now() - startMs).toBeLessThan(500);
  });
});

describe("readCompleteLines", () => {
  const bytesOf = (text: string) => new TextEncoder().encode(text);

  test("leaves a line still being written for next time", () => {
    expect(readCompleteLines(bytesOf('{"a":1}\n{"b":'))).toEqual({ lines: ['{"a":1}'], usedByteCount: 8 });
  });

  test("nothing complete yet", () => {
    expect(readCompleteLines(bytesOf('{"a":'))).toEqual({ lines: [], usedByteCount: 0 });
  });

  test("counts bytes, not characters", () => {
    expect(readCompleteLines(bytesOf("é\n")).usedByteCount).toBe(3);
  });
});

test("readCommandPrompt is null for an ordinary message", () => {
  expect(readCommandPrompt("hello")).toBeNull();
});

test.each([
  [{ description: "Show status", command: "git status" }, "Show status"],
  [{ file_path: "/a/b.ts" }, "/a/b.ts"],
  [{ command: "a\n  b" }, "a b"],
  [{ other: 1 }, ""],
  [null, ""],
])("summarizeToolInput %#", (input, summary) => {
  expect(summarizeToolInput(input)).toBe(summary);
});

test("buildMessageWithImages puts each image's path after the text", () => {
  expect(buildMessageWithImages(" look ", ["/u/a.png", "/u/b.png"])).toBe("look\n\n/u/a.png\n\n/u/b.png");
  expect(buildMessageWithImages("", ["/u/a.png"])).toBe("/u/a.png");
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

test("a message can't end the paste early and type keystrokes", () => {
  const sneaky = "hello\x1b[201~\r!rm -rf ~\r";
  expect(buildPastedText(sneaky)).toBe("\x1b[200~hello[201~!rm -rf ~\x1b[201~");
});

test("removeControlCharacters keeps line breaks and tabs only", () => {
  expect(removeControlCharacters("a\nb\tc\x00d\x07e\x9bf\x7fg")).toBe("a\nb\tcdefg");
});


describe("createCoalescer", () => {
  test("collapses a burst into one run per window, then re-arms", () => {
    let runs = 0;
    const scheduled: (() => void)[] = [];
    const coalesced = createCoalescer(
      () => { runs += 1; },
      100,
      (fn) => scheduled.push(fn),
    );
    for (let i = 0; i < 50; i += 1) coalesced(); // a burst of 50 calls
    expect(scheduled.length).toBe(1); // only one run scheduled
    scheduled[0](); // the window elapses
    expect(runs).toBe(1);
    coalesced(); // a new call after the run re-arms
    expect(scheduled.length).toBe(2);
  });
});

describe("isTurnChangingKeys", () => {
  test.each([
    ["Enter", "\r", true],
    ["a typed line and Enter", "fix it\r", true],
    ["a lone Esc", "\x1b", true],
    ["Ctrl-C", "\x03", true],
    ["a double Esc", "\x1b\x1b", true],
    ["Esc in kitty key encoding", "\x1b[27u", true],
    ["Ctrl-C in kitty key encoding", "\x1b[99;5u", true],
    ["Ctrl-C in modifyOtherKeys encoding", "\x1b[27;5;99~", true],
    ["an arrow key", "\x1b[A", false],
    ["Page Up", "\x1b[5~", false],
    ["plain letters", "abc", false],
    ["nothing", "", false],
  ])("%s → %p", (_name, keys, expected) => {
    expect(isTurnChangingKeys(new TextEncoder().encode(keys))).toBe(expected);
  });
});

describe("isDraftChangingKeys", () => {
  test.each([
    ["a letter", "a", true],
    ["a pasted line", "fix the build", true],
    ["Backspace", "\x7f", true],
    ["an arrow key", "\x1b[A", false],
    ["a focus-in report", "\x1b[I", false],
    ["a cursor position report", "\x1b[12;40R", false],
    ["nothing", "", false],
  ])("%s → %p", (_name, keys, expected) => {
    expect(isDraftChangingKeys(new TextEncoder().encode(keys))).toBe(expected);
  });
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

describe("allowTranscriptSwitch", () => {
  test("allows the first transcript (no current)", () => {
    expect(allowTranscriptSwitch("/home/me/.claude/projects/proj/abc.jsonl", null)).toBe(true);
  });
  test("allows a rotation within the same project folder", () => {
    const dir = "/home/me/.claude/projects/proj";
    expect(allowTranscriptSwitch(`${dir}/new.jsonl`, `${dir}/old.jsonl`)).toBe(true);
  });
  test("refuses a switch to another folder (an unrelated file to read)", () => {
    expect(allowTranscriptSwitch("/tmp/evil.jsonl", "/home/me/.claude/projects/proj/old.jsonl")).toBe(false);
  });
});
