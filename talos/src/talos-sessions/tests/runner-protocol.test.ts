import { describe, expect, test } from "bun:test";
import { encodeRunnerEvent, parseRunnerEvent, type RunnerEvent } from "../client/runner-protocol";

describe("the runner's event stream", () => {
  const sessions = [{ sessionName: "fix", folderName: "talos", state: "idle", asks: {}, openOutputs: [] }] as const;
  test.each([
    ["the session list", { type: "sessions", sessions }],
    ["a session's entries", { type: "session-entries", sessionName: "fix", entries: [{ kind: "text", position: 0, entryId: "a", text: "hi" }] }],
    ["a notice", { type: "notice", sessionName: "fix", message: "An answer was dropped" }],
  ])("%s comes back as it went", (_name, runnerEvent) => {
    const line = encodeRunnerEvent(runnerEvent as RunnerEvent);
    expect(line.indexOf("\n")).toBe(line.length - 1);
    expect(parseRunnerEvent(line.trimEnd())).toEqual(runnerEvent as RunnerEvent);
  });
  test.each([
    ["not JSON", "{"],
    ["not an object", "5"],
    ["an unknown type", JSON.stringify({ type: "other" })],
    ["a session list that isn't a list", JSON.stringify({ type: "sessions", sessions: {} })],
    ["entries with no session name", JSON.stringify({ type: "session-entries", entries: [] })],
    ["entries that aren't a list", JSON.stringify({ type: "session-entries", sessionName: "fix", entries: {} })],
    ["a notice whose message isn't text", JSON.stringify({ type: "notice", sessionName: "fix", message: 5 })],
    ["a notice with no session name", JSON.stringify({ type: "notice", message: "x" })],
  ])("%s is turned down", (_name, line) => {
    expect(parseRunnerEvent(line)).toBeNull();
  });
});
