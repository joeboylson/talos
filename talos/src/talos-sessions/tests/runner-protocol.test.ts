import { describe, expect, test } from "bun:test";
import { encodeHookLine, encodeRunnerEvent, parseRunnerEvent, readHookAnswer, readHookRequest, type RunnerEvent } from "../client/runner-protocol";

describe("the hooks socket's line exchange", () => {
  test("a request comes back as it went", () => {
    const request = { sessionName: "fix", token: "t", details: '{"hook_event_name":"Stop"}\nmore' };
    const line = encodeHookLine(request);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.indexOf("\n")).toBe(line.length - 1);
    expect(readHookRequest(line.trimEnd())).toEqual(request);
  });
  test("an answer comes back as it went", () => {
    expect(readHookAnswer(encodeHookLine({ kind: "reply", reply: "{}" }).trimEnd())).toEqual({ kind: "reply", reply: "{}" });
    expect(readHookAnswer(encodeHookLine({ kind: "too-big" }).trimEnd())).toEqual({ kind: "too-big" });
  });
  test.each([
    ["not JSON", "nope"],
    ["a missing token", JSON.stringify({ sessionName: "fix", details: "{}" })],
    ["details that aren't text", JSON.stringify({ sessionName: "fix", token: "t", details: {} })],
  ])("a request that's %s is turned down", (_name, line) => {
    expect(readHookRequest(line)).toBeNull();
  });
  test("the MCP server's ask for its tools, and the answers to it, come back as they went", () => {
    const ask = { sessionName: "fix", token: "t", wants: "kinds" as const };
    expect(readHookRequest(encodeHookLine(ask).trimEnd())).toEqual(ask);
    const tools = { kind: "tools" as const, tools: [{ name: "send_poll", description: "d", inputSchema: { type: "object" }, reply: "Recorded." }] };
    expect(readHookAnswer(encodeHookLine(tools).trimEnd())).toEqual(tools);
    expect(readHookAnswer(encodeHookLine({ kind: "refused" }).trimEnd())).toEqual({ kind: "refused" });
  });
  test("a tools answer with one bad tool is turned down whole", () => {
    expect(readHookAnswer(JSON.stringify({ kind: "tools", tools: [{ name: "x", description: "d", inputSchema: null, reply: "r" }] }))).toBeNull();
  });
  test("an unknown answer is turned down", () => {
    expect(readHookAnswer(JSON.stringify({ kind: "maybe" }))).toBeNull();
  });
});

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

describe("hook line edges", () => {
  test("a request with no session name is turned down", () => {
    expect(readHookRequest(JSON.stringify({ token: "t", details: "{}" }))).toBeNull();
  });
  test("a reply that isn't text is turned down", () => {
    expect(readHookAnswer(JSON.stringify({ kind: "reply", reply: 5 }))).toBeNull();
  });
  test.each([
    ["no name", { description: "d", inputSchema: {}, reply: "r" }],
    ["no description", { name: "x", inputSchema: {}, reply: "r" }],
    ["no reply", { name: "x", description: "d", inputSchema: {} }],
  ])("a tool with %s is turned down", (_name, tool) => {
    expect(readHookAnswer(JSON.stringify({ kind: "tools", tools: [tool] }))).toBeNull();
  });
  test("tools that aren't a list are turned down, and an empty list is fine", () => {
    expect(readHookAnswer(JSON.stringify({ kind: "tools", tools: {} }))).toBeNull();
    expect(readHookAnswer(JSON.stringify({ kind: "tools", tools: [] }))).toEqual({ kind: "tools", tools: [] });
  });
});
