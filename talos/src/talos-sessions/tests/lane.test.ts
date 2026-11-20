import { describe, expect, test } from "bun:test";
import { mcpToolName, type Catalog, type OutputKind } from "../kinds";
import { NO_LANE, hookReplyWhenRunnerUnreachable, hookReplyWhenTooBig, readLaneEvent, stepLane, type Lane, type LaneEvent } from "../lanes/lane";
import { SESSION_LIMITS } from "../limits";

// Made-up kinds, so the lane is tested without talos's own:
// poll is asked for; note may be sent in a prose turn and waits for an answer;
// tally is asked for too, but is never in a prose turn.
const kindOf = (kind: string, extra: Partial<OutputKind> = {}): OutputKind => ({
  kind,
  toolName: `send_${kind}`,
  description: `send a ${kind}`,
  inputSchema: { type: "object" },
  readFields: (toolInput) => (typeof (toolInput as { text?: unknown })?.text === "string" ? { text: (toolInput as { text: string }).text } : null),
  badInputReason: `Call send_${kind} with text.`,
  acceptedReply: "Recorded.",
  waits: false,
  ...extra,
});
const POLL = kindOf("poll", { requestText: "Send a poll." });
const NOTE = kindOf("note", { waits: true });
const TALLY = kindOf("tally", { requestText: "Send a tally." });
const CATALOG: Catalog = { kinds: [POLL, NOTE, TALLY], proseTurn: { output: "prose", optional: ["note"] } };

const NOW = 1_000_000;
const queued: Lane = { stage: "queued", output: "poll", askedAtMs: NOW };
const asking: Lane = { stage: "asking", output: "poll", askedAtMs: NOW, hasForcedStop: false };
const askingForced: Lane = { stage: "asking", output: "poll", askedAtMs: NOW, hasForcedStop: true };
const answered: Lane = { stage: "answered", output: "poll", askedAtMs: NOW };

const toolCall = (toolName: string, toolInput: unknown = {}, isSubagent = false): LaneEvent => ({ type: "pre-tool-use", toolName, toolInput, isSubagent });
const send = (kind: OutputKind, text: unknown = "hi", isSubagent = false) => toolCall(mcpToolName(kind.toolName), { text }, isSubagent);
const bash = toolCall("Bash", { command: "ls" });

// The hook's decision in one word: "" (none), allow, deny or block.
const decisionOf = (hookReply: string): string => {
  if (!hookReply) return "";
  const reply = JSON.parse(hookReply);
  return reply.hookSpecificOutput?.permissionDecision ?? reply.decision;
};

const step = (lane: Lane, event: LaneEvent, nowMs = NOW) => {
  const result = stepLane(lane, event, nowMs, CATALOG);
  return { lane: result.lane, decision: decisionOf(result.hookReply), ask: result.askChange?.state ?? null, typed: result.requestToType };
};
const unchanged = (lane: Lane, decision = "") => ({ lane, decision, ask: null, typed: null });

describe("1. an asked-for turn runs no tool but its kind's", () => {
  test.each([
    ["asking", asking],
    ["answered", answered],
  ])("%s denies any other tool, and other kinds", (_name, lane) => {
    expect(step(lane, bash)).toEqual(unchanged(lane, "deny"));
    expect(step(lane, send(NOTE))).toEqual(unchanged(lane, "deny"));
    expect(step(lane, send(TALLY))).toEqual(unchanged(lane, "deny"));
  });
});

describe("1b. an asked-for turn may look up its tool's fields", () => {
  test.each([
    ["asking", asking],
    ["answered", answered],
  ])("ToolSearch runs while %s", (_name, lane) => {
    expect(step(lane, toolCall("ToolSearch", { query: "select:mcp__talos__send_poll" }))).toEqual(unchanged(lane));
  });
});

describe("2. a prose turn runs everything but what its shape leaves out", () => {
  test.each([
    ["asking", asking],
    ["answered", answered],
  ])("a background sub-agent's tools keep running while %s", (_name, lane) => {
    expect(step(lane, toolCall("Bash", { command: "ls" }, true))).toEqual(unchanged(lane));
  });
  test.each([
    ["no ask", NO_LANE],
    ["an ask queued", queued],
  ])("%s lets other tools through and denies a kind only asked for", (_name, lane) => {
    expect(step(lane, bash)).toEqual(unchanged(lane));
    expect(step(lane, send(POLL))).toEqual(unchanged(lane, "deny"));
    expect(step(lane, send(TALLY))).toEqual(unchanged(lane, "deny"));
  });
});

describe("3. nothing but an answer or the timeout ends an asked-for turn", () => {
  test("the first unanswered Stop is blocked to force the answer", () => {
    expect(step(asking, { type: "stop" })).toEqual(unchanged(askingForced, "block"));
  });
  test("a later unanswered Stop goes through, but the turn stays open", () => {
    expect(step(askingForced, { type: "stop" })).toEqual(unchanged(askingForced));
  });
  test("settling mid-turn doesn't end or restart it", () => {
    expect(step(asking, { type: "settled", hasDraft: false })).toEqual(unchanged(asking));
  });
  test.each([
    ["queued", queued],
    ["asking", asking],
    ["answered", answered],
  ])("a repeat ask, of any kind, while %s is ignored (no clock reset, no retype)", (_name, lane) => {
    expect(step(lane, { type: "ask", kind: "poll" }, NOW + 5000)).toEqual(unchanged(lane));
    expect(step(lane, { type: "ask", kind: "tally" }, NOW + 5000)).toEqual(unchanged(lane));
  });
  test("the person typing ends an unanswered turn, so their message's tools run", () => {
    expect(step(askingForced, { type: "person-typed", isTurnChanging: true })).toEqual({ lane: NO_LANE, decision: "", ask: "no-response", typed: null });
    expect(step(NO_LANE, bash)).toEqual(unchanged(NO_LANE));
  });
  test("the person typing after an answer keeps the answer", () => {
    expect(step(answered, { type: "person-typed", isTurnChanging: true })).toEqual(unchanged(NO_LANE));
  });
  test("the person typing ends a queued ask, so their message isn't taken into an asked-for turn", () => {
    expect(step(queued, { type: "person-typed", isTurnChanging: true })).toEqual({ lane: NO_LANE, decision: "", ask: "no-response", typed: null });
  });
  test.each([
    ["asking", asking],
    ["answered", answered],
  ])("a key that doesn't change the turn (like an arrow) leaves %s alone", (_name, lane) => {
    expect(step(lane, { type: "person-typed", isTurnChanging: false })).toEqual(unchanged(lane));
  });
  test("any key ends a queued ask, so a draft isn't sent with the request", () => {
    expect(step(queued, { type: "person-typed", isTurnChanging: false }).lane).toEqual(NO_LANE);
  });
  test("a Stop after the answer doesn't end it: a session can forge one mid-turn", () => {
    expect(step(answered, { type: "stop" })).toEqual(unchanged(answered));
    expect(step(answered, bash)).toEqual(unchanged(answered, "deny"));
  });
  test("the turn ends once it's over and the screen has settled", () => {
    expect(step(answered, { type: "settled", hasDraft: false })).toEqual(unchanged(NO_LANE));
  });
});

describe("4. an answer is only this session's own, in its turn", () => {
  test("a valid answer in the turn is allowed and recorded", () => {
    const result = stepLane(asking, send(POLL, "yes"), NOW, CATALOG);
    expect({ ...step(asking, send(POLL, "yes")), recorded: result.recorded }).toEqual({
      lane: answered,
      decision: "allow",
      ask: "answered",
      typed: null,
      recorded: { kind: "poll", fields: { text: "yes" }, atMs: NOW },
    });
  });
  test("a later answer in the same turn replaces the first", () => {
    expect(stepLane(answered, send(POLL, "no"), NOW, CATALOG).recorded?.fields).toEqual({ text: "no" });
  });
  test("a sub-agent's answer is denied and not recorded", () => {
    expect(step(asking, send(POLL, "forged", true))).toEqual(unchanged(asking, "deny"));
  });
});

describe("5. a bad or missing answer fails safe", () => {
  test.each([
    ["fields the kind's check turns down", 5],
    ["no input", undefined],
  ])("%s is denied and records nothing", (_name, text) => {
    expect(step(asking, toolCall(mcpToolName(POLL.toolName), text === undefined ? null : { text }))).toEqual(unchanged(asking, "deny"));
  });
  test("an unanswered turn becomes no-response at the timeout, but stays limited until it settles", () => {
    expect(step(asking, { type: "tick" }, NOW + SESSION_LIMITS.askTimeoutMs + 1)).toEqual({ lane: answered, decision: "", ask: "no-response", typed: null });
    expect(step(answered, bash, NOW + SESSION_LIMITS.askTimeoutMs + 2)).toEqual(unchanged(answered, "deny"));
  });
  test("a queued ask waits for long work to finish", () => {
    expect(step(queued, { type: "tick" }, NOW + SESSION_LIMITS.queuedAskTimeoutMs)).toEqual(unchanged(queued));
  });
  test("a queued ask that never starts becomes no-response", () => {
    expect(step(queued, { type: "tick" }, NOW + SESSION_LIMITS.queuedAskTimeoutMs + 1)).toEqual({ lane: NO_LANE, decision: "", ask: "no-response", typed: null });
  });
  test("an answered turn that never settles ends at the long backstop and keeps its answer", () => {
    expect(step(answered, { type: "tick" }, NOW + SESSION_LIMITS.askTimeoutMs + 1)).toEqual(unchanged(answered));
    expect(step(answered, { type: "tick" }, NOW + SESSION_LIMITS.queuedAskTimeoutMs + 1)).toEqual(unchanged(NO_LANE));
  });
  test("nothing times out early", () => {
    expect(step(asking, { type: "tick" }, NOW + SESSION_LIMITS.askTimeoutMs)).toEqual(unchanged(asking));
  });
});

describe("asking", () => {
  test("an ask queues, so the request is only typed once the turn is over", () => {
    expect(step(NO_LANE, { type: "ask", kind: "poll" })).toEqual({ lane: queued, decision: "", ask: "asking", typed: null });
  });
  test("a kind with no request, or none at all, can't be asked for", () => {
    expect(step(NO_LANE, { type: "ask", kind: "note" })).toEqual(unchanged(NO_LANE));
    expect(step(NO_LANE, { type: "ask", kind: "nope" })).toEqual(unchanged(NO_LANE));
  });
  test("settling types the kind's request and starts the turn's clock", () => {
    expect(step(queued, { type: "settled", hasDraft: false }, NOW + 10)).toEqual({ lane: { ...asking, askedAtMs: NOW + 10 }, decision: "", ask: null, typed: "Send a poll." });
  });
  test("a queued ask that meets a draft ends: the request would be sent with it", () => {
    expect(step(queued, { type: "settled", hasDraft: true })).toEqual({ lane: NO_LANE, decision: "", ask: "no-response", typed: null });
  });
});

describe("an optional output in a prose turn", () => {
  test.each([
    ["no ask", NO_LANE],
    ["an ask queued", queued],
  ])("may be sent (%s): allowed and recorded, lane unchanged, no ask touched", (_name, lane) => {
    const result = stepLane(lane, send(NOTE, "which?"), NOW, CATALOG);
    expect(decisionOf(result.hookReply)).toBe("allow");
    expect(result.recorded).toEqual({ kind: "note", fields: { text: "which?" }, atMs: NOW });
    expect(result.lane).toEqual(lane);
    expect(result.askChange).toBeNull();
  });
  test("a sub-agent may not send one: it isn't the session asking", () => {
    const result = stepLane(NO_LANE, send(NOTE, "x", true), NOW, CATALOG);
    expect(decisionOf(result.hookReply)).toBe("deny");
    expect(result.recorded).toBeNull();
  });
  test("fields its kind turns down are denied", () => {
    expect(decisionOf(stepLane(NO_LANE, send(NOTE, 5), NOW, CATALOG).hookReply)).toBe("deny");
  });
  test("the person's next submitted message answers open outputs, so they close", () => {
    expect(stepLane(NO_LANE, { type: "prompt-submitted", prompt: "yes" }, NOW, CATALOG).closesOpenOutputs).toBe(true);
  });
  test("keys alone don't close them: Enter may be answering a permission prompt", () => {
    expect(stepLane(NO_LANE, { type: "person-typed", isTurnChanging: true }, NOW, CATALOG).closesOpenOutputs).toBe(false);
  });
  test("a request talos types isn't an answer", () => {
    expect(stepLane(queued, { type: "prompt-submitted", prompt: "Send a poll." }, NOW, CATALOG).closesOpenOutputs).toBe(false);
  });
});

describe("readLaneEvent", () => {
  test.each([
    ["a tool call", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }, bash],
    ["a sub-agent's tool call", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, agent_id: "a1" }, { ...bash, isSubagent: true }],
    ["a Stop", { hook_event_name: "Stop", stop_hook_active: true }, { type: "stop" }],
    ["a submitted prompt", { hook_event_name: "UserPromptSubmit", prompt: "hi" }, { type: "prompt-submitted", prompt: "hi" }],
    ["another event", { hook_event_name: "PostToolUse" }, null],
    ["not an object", 5, null],
  ] as [string, unknown, LaneEvent | null][])("%s", (_name, hookDetails, expected) => {
    expect(readLaneEvent(hookDetails)).toEqual(expected);
  });
});

describe("hookReplyWhenRunnerUnreachable", () => {
  test.each([
    ["a known structured tool", mcpToolName(POLL.toolName)],
    ["any tool under talos's name", mcpToolName("anything")],
  ])("denies %s: nothing would record it", (_name, toolName) => {
    expect(decisionOf(hookReplyWhenRunnerUnreachable({ hook_event_name: "PreToolUse", tool_name: toolName }))).toBe("deny");
  });
  test.each([
    ["another tool", { hook_event_name: "PreToolUse", tool_name: "Bash" }],
    ["a Stop", { hook_event_name: "Stop" }],
    ["unreadable details", null],
  ] as [string, unknown][])("lets %s through", (_name, hookDetails) => {
    expect(hookReplyWhenRunnerUnreachable(hookDetails)).toBe("");
  });
});

describe("hookReplyWhenTooBig", () => {
  test("denies any tool call talos couldn't read", () => {
    expect(decisionOf(hookReplyWhenTooBig({ hook_event_name: "PreToolUse", tool_name: "Bash" }))).toBe("deny");
  });
  test("leaves other events alone", () => {
    expect(hookReplyWhenTooBig({ hook_event_name: "Stop" })).toBe("");
  });
});
