import { describe, expect, test } from "bun:test";
import { encodeHookLine, readHookAnswer, readHookRequest } from "../client/runner-protocol";

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
