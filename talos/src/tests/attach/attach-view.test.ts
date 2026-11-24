import { describe, expect, test } from "bun:test";
import { entryLines, isTurnRunning, readSessionChoice, readTyped, sessionChoiceLines, stateLine } from "../../attach-view";
import type { SessionEntry, SessionSummary } from "../../talos-sessions";

const session = (changes: Partial<SessionSummary> = {}): SessionSummary => ({ sessionName: "fix", folderName: "talos", state: "idle", asks: {}, openOutputs: [], isTurnOver: true, ...changes });
const decision = { id: "q1", kind: "decision", fields: { question: "Tabs or spaces?", choices: ["Tabs", "Spaces"] }, atMs: 1 };
const asking = session({ state: "needs-you", isTurnOver: false, permissionAsks: [{ id: "tu1", tool: "Bash", summary: "rm -rf build" }] });
const questioned = session({ state: "needs-you", openOutputs: [decision] });

describe("each entry as lines", () => {
  test.each([
    ["a message, with its images", { kind: "prompt", entryId: "e", position: 0, text: "look\nhere", imageCount: 2 }, ["› look", "› here [2 images]"]],
    ["Claude's words", { kind: "text", entryId: "e", position: 0, text: "done\nall good" }, ["done", "all good"]],
    ["a tool call", { kind: "tool", entryId: "e", position: 0, toolName: "Bash", summary: "ls", outcome: "done" }, ["  · Bash ls"]],
    ["a question with its choices", { kind: "output", entryId: "e", position: 0, outputKind: "decision", fields: decision.fields }, ["? Tabs or spaces?", "  1) Tabs", "  2) Spaces"]],
    ["something dropped", { kind: "dropped", entryId: "e", position: 0, droppedKind: "text", reason: "too long" }, ["  (something here failed its check: too long)"]],
  ] as [string, SessionEntry, string[]][])("%s", (_name, entry, lines) => {
    expect(entryLines(entry)).toEqual(lines);
  });
});

describe("what it waits on", () => {
  test.each([
    ["a permission question, first", asking, "allow Bash: rm -rf build? y/n"],
    ["an open question once its turn is over", questioned, "answer 1-2, or type your own"],
    ["a running turn", session({ state: "working", isTurnOver: false }), "working (Ctrl-C stops it)"],
    ["nothing", session(), "ready"],
  ])("%s", (_name, summary, line) => {
    expect(stateLine(summary)).toBe(line);
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

describe("choosing a session to attach to", () => {
  const running = [session({ sessionName: "fix-login" }), session({ sessionName: "website", folderName: "site", state: "working", isTurnOver: false })];
  test("each is listed with its number, folder and state", () => {
    expect(sessionChoiceLines(running)).toEqual(["  1) fix-login  (talos, ready)", "  2) website  (site, working)"]);
  });
  test("an answer picks one by its number or its name, and anything else none", () => {
    expect(readSessionChoice("2", running)?.sessionName).toBe("website");
    expect(readSessionChoice(" fix-login ", running)?.sessionName).toBe("fix-login");
    expect(readSessionChoice("3", running)).toBeNull();
    expect(readSessionChoice("0", running)).toBeNull();
    expect(readSessionChoice("", running)).toBeNull();
  });
});

test("Ctrl-C stops a turn that's running, a permission question included", () => {
  expect(isTurnRunning(session({ state: "working", isTurnOver: false }))).toBe(true);
  expect(isTurnRunning(asking)).toBe(true);
  expect(isTurnRunning(questioned)).toBe(false);
});
