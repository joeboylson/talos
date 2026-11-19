import { describe, expect, test } from "bun:test";
import {
  allowTranscriptSwitch,
  readCommandPrompt,
  readCompleteLines,
  readTranscriptLine,
  resolveTranscriptItems,
  summarizeToolInput,
} from "../../transcript-lines";

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

  test("an entry the shared reader would turn down is dropped alone", () => {
    const longId = { kind: "text", entryId: "x".repeat(201), text: "hi" } as const;
    const fine = { kind: "text", entryId: "ok", text: "hi" } as const;
    expect(resolveTranscriptItems([longId, fine], new Map()).entries).toEqual([fine]);
  });

  test("doesn't mutate the knownTools it was given", () => {
    const knownTools = new Map([["t1", running]]);
    resolveTranscriptItems([{ kind: "tool-end", toolUseId: "t1", isFailed: false }], knownTools);
    expect([...knownTools]).toEqual([["t1", running]]);
  });

  test("stays linear on a large read (would be seconds if quadratic)", () => {
    const items = Array.from({ length: 50_000 }, (_unused, i) => ({ kind: "text" as const, entryId: `e${i}`, text: "x" }));
    const startMs = Date.now();
    const { entries } = resolveTranscriptItems(items, new Map());
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
