import { describe, expect, test } from "bun:test";
import { MAX_STATUS_NOTE_LENGTH } from "talos-shared";
import { QUEUED_STATUS_TIMEOUT_MS, STATUS_TIMEOUT_MS, STATUS_TOOL_NAME } from "../../constants";
import {
  NO_STATUS_LANE,
  hookReplyWhenHostUnreachable,
  readStatusLaneEvent,
  stepStatusLane,
  type StatusLane,
  type StatusLaneEvent,
} from "../../status-lane";

const NOW = 1_000_000;
const queued: StatusLane = { kind: "queued", askedAtMs: NOW };
const asking: StatusLane = { kind: "asking", askedAtMs: NOW, hasForcedStop: false };
const askingForced: StatusLane = { kind: "asking", askedAtMs: NOW, hasForcedStop: true };
const reported: StatusLane = { kind: "reported", askedAtMs: NOW };

const toolCall = (toolName: string, toolInput: unknown = {}, isSubagent = false): StatusLaneEvent => ({
  type: "pre-tool-use",
  toolName,
  toolInput,
  isSubagent,
});
const report = (state: string, note: string, isSubagent = false) => toolCall(STATUS_TOOL_NAME, { state, note }, isSubagent);
const bash = toolCall("Bash", { command: "ls" });

// The hook's decision in one word: "" (none), allow, deny or block.
const decisionOf = (hookReply: string): string => {
  if (!hookReply) return "";
  const reply = JSON.parse(hookReply);
  return reply.hookSpecificOutput?.permissionDecision ?? reply.decision;
};

const step = (lane: StatusLane, event: StatusLaneEvent, nowMs = NOW) => {
  const result = stepStatusLane(lane, event, nowMs);
  return { lane: result.lane, decision: decisionOf(result.hookReply), status: result.statusChange?.state ?? null, typed: result.shouldTypeRequest };
};
const unchanged = (lane: StatusLane, decision = "") => ({ lane, decision, status: null, typed: false });

describe("1. a status turn runs no tool but report_status", () => {
  test.each([
    ["asking", asking],
    ["reported", reported],
  ])("%s denies any other tool", (_name, lane) => {
    expect(step(lane, bash)).toEqual(unchanged(lane, "deny"));
  });
});

describe("2. a chat turn runs everything but report_status", () => {
  test.each([
    ["no ask", NO_STATUS_LANE],
    ["an ask queued", queued],
  ])("%s lets other tools through and denies report_status", (_name, lane) => {
    expect(step(lane, bash)).toEqual(unchanged(lane));
    expect(step(lane, report("done", "all good"))).toEqual(unchanged(lane, "deny"));
  });
});

describe("3. nothing but a report or the timeout ends a status turn", () => {
  test("the first unanswered Stop is blocked to force the report", () => {
    expect(step(asking, { type: "stop" })).toEqual(unchanged(askingForced, "block"));
  });
  test("a later unanswered Stop goes through, but the turn stays open", () => {
    expect(step(askingForced, { type: "stop" })).toEqual(unchanged(askingForced));
  });
  test("going idle mid-turn doesn't end or restart it", () => {
    expect(step(asking, { type: "idle" })).toEqual(unchanged(asking));
  });
  test.each([
    ["queued", queued],
    ["asking", asking],
    ["reported", reported],
  ])("a repeat ask while %s is ignored (no clock reset, no retype)", (_name, lane) => {
    expect(step(lane, { type: "ask", isIdle: true }, NOW + 5000)).toEqual(unchanged(lane));
  });
  test("the person typing ends an unanswered turn, so their message's tools run", () => {
    expect(step(askingForced, { type: "person-typed" })).toEqual({ lane: NO_STATUS_LANE, decision: "", status: "no-response", typed: false });
    expect(step(NO_STATUS_LANE, bash)).toEqual(unchanged(NO_STATUS_LANE));
  });
  test("the person typing after a report keeps the report", () => {
    expect(step(reported, { type: "person-typed" })).toEqual(unchanged(NO_STATUS_LANE));
  });
  test("the person typing ends a queued ask, so their message isn't taken into a status turn", () => {
    expect(step(queued, { type: "person-typed" })).toEqual({ lane: NO_STATUS_LANE, decision: "", status: "no-response", typed: false });
  });
  test("a Stop after the report ends the turn", () => {
    expect(step(reported, { type: "stop" })).toEqual(unchanged(NO_STATUS_LANE));
  });
});

describe("4. a status is only this session's own answer, in a status turn", () => {
  test("a valid report in the turn is allowed and recorded", () => {
    expect(step(asking, report("stuck", "tests fail"))).toEqual({ lane: reported, decision: "allow", status: "stuck", typed: false });
  });
  test("a later report in the same turn replaces the first", () => {
    expect(step(reported, report("done", "fixed")).status).toBe("done");
  });
  test("a sub-agent's report is denied and not recorded", () => {
    expect(step(asking, report("done", "forged", true))).toEqual(unchanged(asking, "deny"));
  });
  test("the recorded note has no control characters or line breaks", () => {
    const result = stepStatusLane(asking, report("done", "line1\nline2\t\u001b[31mred"), NOW);
    expect(result.statusChange).toEqual({ state: "done", note: "line1 line2 [31mred", atMs: NOW });
  });
});

describe("5. a bad or missing report fails safe", () => {
  test.each([
    ["an unknown state", { state: "great", note: "x" }],
    ["a note that isn't text", { state: "done", note: 5 }],
    ["a note too long", { state: "done", note: "x".repeat(MAX_STATUS_NOTE_LENGTH + 1) }],
    ["no input", null],
  ])("%s is denied and records nothing", (_name, toolInput) => {
    expect(step(asking, toolCall(STATUS_TOOL_NAME, toolInput))).toEqual(unchanged(asking, "deny"));
  });
  test("an unanswered turn becomes no-response at the timeout", () => {
    expect(step(asking, { type: "tick" }, NOW + STATUS_TIMEOUT_MS + 1)).toEqual({ lane: NO_STATUS_LANE, decision: "", status: "no-response", typed: false });
  });
  test("a queued ask waits for long work to finish", () => {
    expect(step(queued, { type: "tick" }, NOW + QUEUED_STATUS_TIMEOUT_MS)).toEqual(unchanged(queued));
  });
  test("a queued ask that never starts becomes no-response", () => {
    expect(step(queued, { type: "tick" }, NOW + QUEUED_STATUS_TIMEOUT_MS + 1)).toEqual({ lane: NO_STATUS_LANE, decision: "", status: "no-response", typed: false });
  });
  test("a reported turn that never stopped ends at the timeout and keeps its status", () => {
    expect(step(reported, { type: "tick" }, NOW + STATUS_TIMEOUT_MS + 1)).toEqual(unchanged(NO_STATUS_LANE));
  });
  test("nothing times out early", () => {
    expect(step(asking, { type: "tick" }, NOW + STATUS_TIMEOUT_MS)).toEqual(unchanged(asking));
  });
});

describe("asking", () => {
  test("an idle session is asked now", () => {
    expect(step(NO_STATUS_LANE, { type: "ask", isIdle: true })).toEqual({ lane: asking, decision: "", status: "pending", typed: true });
  });
  test("a busy session is asked when it next goes idle", () => {
    expect(step(NO_STATUS_LANE, { type: "ask", isIdle: false })).toEqual({ lane: queued, decision: "", status: "pending", typed: false });
    expect(step(queued, { type: "idle" }, NOW + 10)).toEqual({ lane: { ...asking, askedAtMs: NOW + 10 }, decision: "", status: null, typed: true });
  });
});

describe("readStatusLaneEvent", () => {
  test.each([
    ["a tool call", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }, bash],
    ["a sub-agent's tool call", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, agent_id: "a1" }, { ...bash, isSubagent: true }],
    ["a Stop", { hook_event_name: "Stop", stop_hook_active: true }, { type: "stop" }],
    ["another event", { hook_event_name: "PostToolUse" }, null],
    ["not an object", 5, null],
  ])("%s", (_name, hookDetails, expected) => {
    expect(readStatusLaneEvent(hookDetails)).toEqual(expected as StatusLaneEvent | null);
  });
});

describe("hookReplyWhenHostUnreachable", () => {
  test("denies report_status", () => {
    expect(decisionOf(hookReplyWhenHostUnreachable({ hook_event_name: "PreToolUse", tool_name: STATUS_TOOL_NAME }))).toBe("deny");
  });
  test.each([
    ["another tool", { hook_event_name: "PreToolUse", tool_name: "Bash" }],
    ["a Stop", { hook_event_name: "Stop" }],
    ["unreadable details", null],
  ])("lets %s through", (_name, hookDetails) => {
    expect(hookReplyWhenHostUnreachable(hookDetails)).toBe("");
  });
});
