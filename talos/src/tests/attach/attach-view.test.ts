import { describe, expect, test } from "bun:test";
import { entryLines, isTurnRunning, paintFor, permissionLine, promptFor, readTyped, statusLine } from "../../attach-view";
import { STATUS_KIND } from "../../session-outputs";
import type { SessionEntry, SessionSummary } from "../../talos-sessions";

const session = (changes: Partial<SessionSummary> = {}): SessionSummary => ({ sessionName: "fix", folderName: "talos", state: "idle", asks: {}, openOutputs: [], isTurnOver: true, ...changes });
const decision = { id: "q1", kind: "decision", fields: { question: "Tabs or spaces?", choices: ["Tabs", "Spaces"] }, atMs: 1 };
const asking = session({ state: "needs-you", isTurnOver: false, permissionAsks: [{ id: "tu1", tool: "Bash", summary: "rm -rf build" }] });
const questioned = session({ state: "needs-you", openOutputs: [decision] });

describe("each entry as lines", () => {
  test.each([
    ["a message, with its images", { kind: "prompt", entryId: "e", position: 0, text: "look\nhere", imageCount: 2 }, ["› look", "  here [2 images]"]],
    ["an answer talos sent for a click, as the choice", { kind: "prompt", entryId: "e", position: 0, text: "Answer to 0f8fad5b-d9cb-469f-a165-70867728950e: Tabs", imageCount: 0 }, ["› Tabs"]],
    ["talos's status request", { kind: "prompt", entryId: "e", position: 0, text: STATUS_KIND.requestText!, imageCount: 0 }, ["  (asked for a status)"]],
    ["Claude's words", { kind: "text", entryId: "e", position: 0, text: "done\nall good" }, ["done", "all good"]],
    ["a tool call that finished", { kind: "tool", entryId: "e", position: 0, toolName: "Bash", summary: "ls", outcome: "done" }, ["  ✓ Bash ls"]],
    ["a tool call that failed", { kind: "tool", entryId: "e", position: 0, toolName: "Edit", summary: "a.ts", outcome: "failed" }, ["  ✗ Edit a.ts"]],
    ["a tool call still running (the state line names it)", { kind: "tool", entryId: "e", position: 0, toolName: "Bash", summary: "ls", outcome: "running" }, []],
    ["a question with its choices", { kind: "output", entryId: "e", position: 0, outputKind: "decision", fields: decision.fields }, ["? Tabs or spaces?", "  1) Tabs", "  2) Spaces"]],
    ["something dropped", { kind: "dropped", entryId: "e", position: 0, droppedKind: "text", reason: "too long" }, ["  (something here failed its check: too long)"]],
  ] as [string, SessionEntry, string[]][])("%s", (_name, entry, lines) => {
    expect(entryLines(entry)).toEqual(lines);
  });
});

describe("the prompt says what it waits on", () => {
  test.each([
    ["a permission question, first", asking, "● allow? y/n › "],
    ["an open question once its turn is over", questioned, "● answer 1-2 › "],
    ["a running turn", session({ state: "working", isTurnOver: false }), "● working › "],
    ["one Claude Code started, its link lost", session({ state: "working", isTurnOver: false, isSelfStarted: true, link: "lost" }), "● working · by Claude Code · link lost › "],
    ["nothing", session(), "● ready › "],
  ])("%s", (_name, summary, prompt) => {
    expect(promptFor(summary)).toBe(prompt);
  });
  test("a running turn names the tool running now, cut short if it's long", () => {
    expect(promptFor(session({ state: "working", isTurnOver: false }), "Bash bun test")).toBe("● Bash bun test › ");
    expect(promptFor(session({ state: "working", isTurnOver: false }), `Bash ${"x".repeat(80)}`)).toBe(`● Bash ${"x".repeat(44)}… › `);
  });
  test("a permission question prints once as a line, as the page's card shows it", () => {
    expect(permissionLine("Bash", "rm -rf build")).toBe("? Allow Bash? rm -rf build y/n");
  });
  test("the status last reported shows as the page shows it", () => {
    expect(statusLine(session({ asks: { status: { state: "answered", atMs: 1, latest: { state: "done", note: "tests pass" } } } }))).toBe("status: done — tests pass");
    expect(statusLine(session())).toBeNull();
  });
  test("colors only where the terminal shows them", () => {
    expect(paintFor(true).green("✓")).toBe("\x1b[32m✓\x1b[39m");
    expect(paintFor(false).green("✓")).toBe("✓");
  });
});

describe("a typed line", () => {
  test("y or n answers a permission question", () => {
    expect(readTyped("y", asking)).toEqual({ do: "permission", id: "tu1", isAllowed: true });
    expect(readTyped(" No ", asking)).toEqual({ do: "permission", id: "tu1", isAllowed: false });
  });
  test("a choice's number answers the open question; one out of range is a message", () => {
    expect(readTyped("2", questioned)).toEqual({ do: "answer", outputId: "q1", choice: 1 });
    expect(readTyped("3", questioned)).toEqual({ do: "send", text: "3" });
  });
  test("anything else is a message, and a blank line is nothing", () => {
    expect(readTyped("yes please, and add tests", asking)).toEqual({ do: "send", text: "yes please, and add tests" });
    expect(readTyped("y", session())).toEqual({ do: "send", text: "y" });
    expect(readTyped("   ", session())).toEqual({ do: "nothing" });
  });
});

test("Ctrl-C stops a turn that's running, a permission question included", () => {
  expect(isTurnRunning(session({ state: "working", isTurnOver: false }))).toBe(true);
  expect(isTurnRunning(asking)).toBe(true);
  expect(isTurnRunning(questioned)).toBe(false);
});
