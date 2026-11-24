import { describe, expect, test } from "bun:test";
import {
  readCommandPrompt,
  numberItems,
  readTranscriptLine,
  resolveTranscriptItems,
  summarizeToolInput,
} from "../transcript/transcript-lines";
import { SESSION_LIMITS } from "../limits";

describe("readTranscriptLine", () => {
  const line = (entry: object) => JSON.stringify({ uuid: "u1", ...entry });
  test("a message typed while Claude works, saved as a queued command, is a prompt", () => {
    const queued = { type: "attachment", attachment: { type: "queued_command", prompt: "Also tell me 2+2.", commandMode: "prompt", humanTurn: true } };
    expect(readTranscriptLine(line(queued))).toEqual([{ kind: "prompt", entryId: "u1", text: "Also tell me 2+2.", imageCount: 0 }]);
    expect(readTranscriptLine(line({ ...queued, attachment: { ...queued.attachment, commandMode: "bash" } }))).toEqual([]);
    expect(readTranscriptLine(line({ type: "attachment", attachment: { type: "file" } }))).toEqual([]);
  });
  test("what a session wrote can't act on a terminal: control characters go, line breaks stay", () => {
    const painted = "\x1b]52;c;aGk=\x07\x1b[2Jcleared\nnext";
    const entries = [
      ...readTranscriptLine(line({ type: "assistant", message: { content: [{ type: "text", text: painted }, { type: "tool_use", id: "t1", name: "Bash\x1b[2J", input: { command: `echo ${painted}` } }] } })),
      ...readTranscriptLine(line({ type: "user", message: { content: painted } })),
      ...readTranscriptLine(line({ type: "user", message: { content: `<local-command-stdout>${painted}</local-command-stdout>` } })),
    ];
    expect(entries).toHaveLength(4);
    expect(JSON.stringify(entries)).not.toMatch(/\\u001b|\\u0007/);
    expect(entries.map((entry) => ("text" in entry ? entry.text.includes("\n") : true))).toEqual([true, true, true, true]);
  });

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
    ["a system line, even with content", line({ type: "system", message: { content: "Conversation compacted" } })],
    ["a line with no id", JSON.stringify({ type: "user", message: { content: "hi" } })],
    ["not JSON", "not json"],
  ])("skips %s", (_name, lineText) => {
    expect(readTranscriptLine(lineText)).toEqual([]);
  });
});

describe("resolveTranscriptItems", () => {
  const running = { kind: "tool", position: 0, entryId: "t1", toolName: "Bash", summary: "ls", outcome: "running" } as const;

  test("a tool's end sends the tool again with how it went", () => {
    const { entries, knownTools } = resolveTranscriptItems([{ kind: "tool-end", toolUseId: "t1", isFailed: false }], new Map([["t1", running]]));
    expect(entries).toEqual([{ ...running, outcome: "done" }]);
    expect(knownTools.size).toBe(0);
  });

  test("a tool started and ended in the same read", () => {
    const { entries } = resolveTranscriptItems([running, { kind: "tool-end", toolUseId: "t1", isFailed: true }], new Map());
    expect(entries).toEqual([running, { ...running, outcome: "failed" }]);
  });

  test("an unknown tool's end is dropped", () => {
    expect(resolveTranscriptItems([{ kind: "tool-end", toolUseId: "zz", isFailed: false }], new Map()).entries).toEqual([]);
  });

  test.each(["toString", "__proto__", "constructor"])("a tool end for %p that never started is dropped", (toolUseId) => {
    expect(resolveTranscriptItems([{ kind: "tool-end", toolUseId, isFailed: false }], new Map()).entries).toEqual([]);
  });

  test("a tool called __proto__ is tracked like any other", () => {
    const sneaky = { ...running, entryId: "__proto__" };
    const { entries } = resolveTranscriptItems([sneaky, { kind: "tool-end", toolUseId: "__proto__", isFailed: false }], new Map());
    expect(entries).toEqual([sneaky, { ...sneaky, outcome: "done" }]);
  });

  test("an entry that fails its check becomes a dropped marker, and its data is handed back to keep aside", () => {
    const longId = { kind: "text", position: 0, entryId: "x".repeat(201), text: "hi" } as const;
    const fine = { kind: "text", position: 0, entryId: "ok", text: "hi" } as const;
    const { entries, rejected } = resolveTranscriptItems([longId, fine], new Map());
    expect(entries[0]).toMatchObject({ kind: "dropped", droppedKind: "text" });
    expect(entries[0]?.entryId).toMatch(/^dropped:/);
    expect(entries[1]).toEqual(fine);
    expect(rejected).toEqual([longId]);
  });

  test("doesn't mutate the knownTools it was given", () => {
    const knownTools = new Map([["t1", running]]);
    resolveTranscriptItems([{ kind: "tool-end", toolUseId: "t1", isFailed: false }], knownTools);
    expect([...knownTools]).toEqual([["t1", running]]);
  });

  test("stays linear on a large read (would be seconds if quadratic)", () => {
    const items = Array.from({ length: 50_000 }, (_unused, i) => ({ kind: "text" as const, position: 0, entryId: `e${i}`, text: "x" }));
    const startMs = Date.now();
    const { entries } = resolveTranscriptItems(items, new Map());
    expect(entries.length).toBe(50_000);
    expect(Date.now() - startMs).toBeLessThan(500);
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

test("command tags are found in linear time, even with many unclosed ones", () => {
  const hostile = "<command-name>".repeat(200_000);
  const startMs = Date.now();
  expect(readCommandPrompt(hostile)).toBeNull();
  expect(Date.now() - startMs).toBeLessThan(500);
});

describe("running tools", () => {
  const tool = (entryId: string) => ({ kind: "tool", position: 0, entryId, toolName: "Bash", summary: "", outcome: "running" }) as const;
  test("a tool the shared reader would turn down isn't tracked", () => {
    expect(resolveTranscriptItems([tool("x".repeat(201))], new Map()).knownTools.size).toBe(0);
  });
  test("at most as many as a session keeps, oldest dropped", () => {
    const items = Array.from({ length: SESSION_LIMITS.maxEntriesKept + 10 }, (_unused, i) => tool(`t${i}`));
    const { knownTools } = resolveTranscriptItems(items, new Map());
    expect(knownTools.size).toBe(SESSION_LIMITS.maxEntriesKept);
    expect(knownTools.has("t0")).toBe(false);
    expect(knownTools.has(`t${SESSION_LIMITS.maxEntriesKept + 9}`)).toBe(true);
  });
});

describe("transcript edges", () => {
  const line = (entry: object) => JSON.stringify({ uuid: "u1", ...entry });
  const userLine = (content: unknown) => readTranscriptLine(line({ type: "user", message: { content } }));
  test("a command's output tag partway through a message is a prompt", () => {
    expect(userLine("see <local-command-stdout>x</local-command-stdout>")).toEqual([
      { kind: "prompt", entryId: "u1", text: "see <local-command-stdout>x</local-command-stdout>", imageCount: 0 },
    ]);
  });
  test("a note after leading spaces is still skipped", () => {
    expect(userLine("  <system-reminder>x</system-reminder>")).toEqual([]);
  });
  test("an image marker with two digits is dropped", () => {
    expect(userLine([{ type: "text", text: "[Image #12]look" }])).toEqual([{ kind: "prompt", entryId: "u1", text: "look", imageCount: 0 }]);
  });
  test("a result whose tool id isn't text is no tool end", () => {
    expect(userLine([{ type: "tool_result", tool_use_id: 7 }])).toEqual([]);
  });
  test("a tool whose id isn't text isn't an entry", () => {
    const content = [{ type: "tool_use", id: 7, name: "Bash", input: {} }];
    expect(readTranscriptLine(line({ type: "assistant", message: { content } }))).toEqual([]);
  });
});

describe("numbering in conversation order", () => {
  test("items are numbered from the session's next number; a tool's end takes its tool's number", () => {
    const { items, nextPosition } = numberItems(
      [
        { kind: "text", entryId: "a", text: "hi" },
        { kind: "tool", entryId: "t1", toolName: "Bash", summary: "", outcome: "running" },
        { kind: "tool-end", toolUseId: "t1", isFailed: false },
        { kind: "structured-call", toolUseId: "s1" },
      ],
      7,
    );
    expect(nextPosition).toBe(10);
    const { entries, structuredCalls } = resolveTranscriptItems(items, new Map());
    expect(entries.map(({ entryId, position }) => `${entryId}@${position}`)).toEqual(["a@7", "t1@8", "t1@8"]);
    expect(structuredCalls).toEqual([{ toolUseId: "s1", position: 9 }]);
  });
  test("a structured tool's call holds its place instead of showing", () => {
    const content = [{ type: "tool_use", id: "s1", name: "mcp__talos__ask_decision", input: {} }];
    expect(readTranscriptLine(JSON.stringify({ uuid: "u1", type: "assistant", message: { content } }))).toEqual([{ kind: "structured-call", toolUseId: "s1" }]);
  });
});
