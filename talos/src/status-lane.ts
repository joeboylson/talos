// A session's turns run in one of two lanes. In the prose lane (an ordinary chat
// turn) it may call any tool, plus the structured tools whose turn is "prose",
// like ask_decision. In the status lane, a status turn the host starts when
// someone asks for an update, it may call report_status and nothing else.
// Every lane change goes through stepStatusLane, a pure function, so the rules
// live in one place and are tested as a table. The host only applies the step
// it returns.
import type { SessionDecision, SessionStatus } from "talos-shared";
import { TALOS_LIMITS } from "./limits";
import { STATUS_TOOL, findStructuredTool, type StructuredRecord, type StructuredTool } from "./structured-tools";

// none: no ask. queued: asked, starts when the session is idle and settled.
// asking: the status turn is running. reported: answered, waiting for its Stop.
// hasForcedStop is kept here rather than read from the hook body's
// stop_hook_active, which a session can forge over its own hook token.
export type StatusLane =
  | { kind: "none" }
  | { kind: "queued"; askedAtMs: number }
  | { kind: "asking"; askedAtMs: number; hasForcedStop: boolean }
  | { kind: "reported"; askedAtMs: number };

export const NO_STATUS_LANE: StatusLane = { kind: "none" };

export type StatusLaneEvent =
  | { type: "ask" }
  // The session's turn is over and its screen has settled (see
  // host/session-state.ts): a request typed now starts a turn of its own, and a
  // finished status turn has really ended.
  | { type: "settled"; hasDraft: boolean }
  | { type: "pre-tool-use"; toolName: string; toolInput: unknown; isSubagent: boolean }
  | { type: "stop" }
  | { type: "prompt-submitted"; prompt: string }
  | { type: "person-typed"; isTurnChanging: boolean }
  | { type: "tick" };

// hookReply is the hook's stdout for Claude Code ("" = no decision). A null
// change leaves that field alone; decisionChange "clear" removes an open one.
export type StatusLaneStep = {
  lane: StatusLane;
  hookReply: string;
  statusChange: SessionStatus | null;
  decisionChange: SessionDecision | "clear" | null;
  shouldTypeRequest: boolean;
};

export const STATUS_REQUEST_PROMPT =
  "Give a status update on this session by calling report_status once, with your state and one short line. Do not do anything else.";

const ONLY_REPORT_REASON = `This is a status update — only ${STATUS_TOOL.bareName} is allowed this turn.`;
const FORCE_REPORT_REASON = `Call ${STATUS_TOOL.bareName} with your state and one short line before finishing.`;
const HOST_UNREACHABLE_REASON = "talos can't record that right now.";
const TOO_BIG_REASON = "This tool call is too big for talos to check.";
const notNowReason = (tool: StructuredTool) => `${tool.bareName} can't be called now.`;
const notThisSessionReason = (tool: StructuredTool) => `Only the session itself can call ${tool.bareName}, not a sub-agent.`;

const allowToolDecision = (): string =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });
const denyToolDecision = (reason: string): string =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
const blockStopDecision = (reason: string): string => JSON.stringify({ decision: "block", reason });

const fieldOf = (value: unknown, field: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, field) : undefined;

// The lane event a hook carries, if any. agent_id marks a sub-agent's hook.
export const readStatusLaneEvent = (hookDetails: unknown): StatusLaneEvent | null => {
  const hookEvent = fieldOf(hookDetails, "hook_event_name");
  if (hookEvent === "Stop") return { type: "stop" };
  if (hookEvent === "UserPromptSubmit") return { type: "prompt-submitted", prompt: String(fieldOf(hookDetails, "prompt") ?? "") };
  if (hookEvent !== "PreToolUse") return null;
  return {
    type: "pre-tool-use",
    toolName: String(fieldOf(hookDetails, "tool_name") ?? ""),
    toolInput: fieldOf(hookDetails, "tool_input"),
    isSubagent: typeof fieldOf(hookDetails, "agent_id") === "string",
  };
};

// What hook.ts prints when it can't reach the host: deny every structured
// tool, so no answer is given that nobody records. Every other tool runs, so a
// host crash doesn't freeze the sessions.
export const hookReplyWhenHostUnreachable = (hookDetails: unknown): string => {
  const event = readStatusLaneEvent(hookDetails);
  const isStructuredCall = event?.type === "pre-tool-use" && findStructuredTool(event.toolName) !== undefined;
  return isStructuredCall ? denyToolDecision(HOST_UNREACHABLE_REASON) : "";
};

// What hook.ts prints when the host turned the hook down as too big to read: a
// tool call talos couldn't check doesn't run, since in a status turn it must not.
export const hookReplyWhenTooBig = (hookDetails: unknown): string =>
  readStatusLaneEvent(hookDetails)?.type === "pre-tool-use" ? denyToolDecision(TOO_BIG_REASON) : "";

const stay = (lane: StatusLane, hookReply = ""): StatusLaneStep => ({
  lane,
  hookReply,
  statusChange: null,
  decisionChange: null,
  shouldTypeRequest: false,
});

const withRecord = (step: StatusLaneStep, record: StructuredRecord): StatusLaneStep =>
  record.kind === "status" ? { ...step, statusChange: record.status } : { ...step, decisionChange: record.decision };

const startStatusTurn = (nowMs: number, statusChange: SessionStatus | null): StatusLaneStep => ({
  ...stay({ kind: "asking", askedAtMs: nowMs, hasForcedStop: false }),
  statusChange,
  shouldTypeRequest: true,
});

// Every ask queues, even to an idle session, so the request is only ever typed
// from the idle event. A repeat ask while one is in flight is ignored:
// re-arming would reset the timeout clock, so a flood of asks could pin a
// session in status-only mode.
const stepAsk = (lane: StatusLane, nowMs: number): StatusLaneStep => {
  if (lane.kind !== "none") return stay(lane);
  const pending: SessionStatus = { state: "pending", note: "", atMs: nowMs };
  return { ...stay({ kind: "queued", askedAtMs: nowMs }), statusChange: pending };
};

// In a status turn only a "status" tool runs. A turn may record its answer
// more than once; the last one stands.
const stepStatusTurnTool = (
  lane: Extract<StatusLane, { kind: "asking" | "reported" }>,
  tool: StructuredTool | undefined,
  toolInput: unknown,
  nowMs: number,
): StatusLaneStep => {
  if (tool?.turn !== "status") return stay(lane, denyToolDecision(ONLY_REPORT_REASON));
  const record = tool.readInput(toolInput, nowMs);
  if (!record) return stay(lane, denyToolDecision(tool.badInputReason));
  return withRecord(stay({ kind: "reported", askedAtMs: lane.askedAtMs }, allowToolDecision()), record);
};

const stepPreToolUse = (lane: StatusLane, event: Extract<StatusLaneEvent, { type: "pre-tool-use" }>, nowMs: number): StatusLaneStep => {
  const tool = findStructuredTool(event.toolName);
  // A sub-agent can't start in a status turn (its tool is denied there), so one
  // running now is chat work started earlier: it keeps every tool but the
  // structured ones, whose answer wouldn't be this session's own.
  if (event.isSubagent) return tool ? stay(lane, denyToolDecision(notThisSessionReason(tool))) : stay(lane);
  if (isStatusTurnRunning(lane)) return stepStatusTurnTool(lane, tool, event.toolInput, nowMs);
  if (!tool) return stay(lane);
  if (tool.turn !== "prose") return stay(lane, denyToolDecision(notNowReason(tool)));
  const record = tool.readInput(event.toolInput, nowMs);
  if (!record) return stay(lane, denyToolDecision(tool.badInputReason));
  return withRecord(stay(lane, allowToolDecision()), record);
};

// A Stop never ends a status turn: a session can forge one, so the turn stays in
// status-only mode until its screen settles with the turn over, the person types,
// or the backstop runs out. An unreported Stop is blocked once to force the report.
const stepStop = (lane: StatusLane): StatusLaneStep => {
  if (lane.kind !== "asking" || lane.hasForcedStop) return stay(lane);
  return stay({ ...lane, hasForcedStop: true }, blockStopDecision(FORCE_REPORT_REASON));
};

// An unanswered ask becomes "no response"; a reported one keeps its status.
const endStatusAsk = (lane: StatusLane, nowMs: number): StatusLaneStep => ({
  ...stay(NO_STATUS_LANE),
  statusChange: lane.kind === "reported" ? null : { state: "no-response", note: "", atMs: nowMs },
});

// Settled: a queued ask is typed now (unless a draft is waiting, which the
// request would be sent along with), and a reported status turn ends.
const stepSettled = (lane: StatusLane, hasDraft: boolean, nowMs: number): StatusLaneStep => {
  if (lane.kind === "reported") return stay(NO_STATUS_LANE);
  if (lane.kind !== "queued") return stay(lane);
  return hasDraft ? endStatusAsk(lane, nowMs) : startStatusTurn(nowMs, null);
};

const isStatusTurnRunning = (lane: StatusLane): lane is Extract<StatusLane, { kind: "asking" | "reported" }> =>
  lane.kind === "asking" || lane.kind === "reported";

// The backstops. An unanswered status turn becomes "no response" but stays in
// status-only mode (as reported, so a late answer still counts) until it
// settles, since the turn itself may still be running. A queued ask, or a
// status turn that never settles, ends after the long wait.
const stepTick = (lane: StatusLane, nowMs: number): StatusLaneStep => {
  if (lane.kind === "none") return stay(lane);
  const waitedMs = nowMs - lane.askedAtMs;
  if (lane.kind === "asking" && waitedMs > TALOS_LIMITS.statusTimeoutMs) {
    return { ...stay({ kind: "reported", askedAtMs: lane.askedAtMs }), statusChange: { state: "no-response", note: "", atMs: nowMs } };
  }
  return waitedMs > TALOS_LIMITS.queuedStatusTimeoutMs ? endStatusAsk(lane, nowMs) : stay(lane);
};

// The person typing ends a queued ask: it would otherwise be pasted
// after their draft at the next Stop and pull it into a status turn, and an Esc
// (which sends no Stop) would leave it pending. A running status turn ends only
// on a turn-changing key (Enter, Esc, Ctrl-C), so watching it with arrow keys
// doesn't lose the report. Only the control socket sends this, so a session
// can't forge it the way it can forge a Stop.
const stepPersonTyped = (lane: StatusLane, isTurnChanging: boolean, nowMs: number): StatusLaneStep => {
  const endsAsk = lane.kind === "queued" || (isStatusTurnRunning(lane) && isTurnChanging);
  return endsAsk ? endStatusAsk(lane, nowMs) : stay(lane);
};

// A prompt Claude Code submits is the person's answer to an open decision, so it
// clears it; keys alone aren't (Enter also answers a permission prompt or picks
// from a menu). The status request talos types isn't an answer. A session can
// forge this for itself, which only clears its own question.
const stepPromptSubmitted = (lane: StatusLane, prompt: string): StatusLaneStep => {
  const isStatusRequest = prompt.trim() === STATUS_REQUEST_PROMPT;
  return isStatusRequest ? stay(lane) : { ...stay(lane), decisionChange: "clear" };
};

export const stepStatusLane = (lane: StatusLane, event: StatusLaneEvent, nowMs: number): StatusLaneStep => {
  if (event.type === "ask") return stepAsk(lane, nowMs);
  if (event.type === "settled") return stepSettled(lane, event.hasDraft, nowMs);
  if (event.type === "pre-tool-use") return stepPreToolUse(lane, event, nowMs);
  if (event.type === "stop") return stepStop(lane);
  if (event.type === "person-typed") return stepPersonTyped(lane, event.isTurnChanging, nowMs);
  if (event.type === "prompt-submitted") return stepPromptSubmitted(lane, event.prompt);
  return stepTick(lane, nowMs);
};
