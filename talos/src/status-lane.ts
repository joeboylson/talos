// The status lane: when someone asks a session for an update, the host types a
// request, and the session must answer by calling report_status and nothing
// else. Every lane change goes through stepStatusLane, a pure function, so the
// rules live in one place and are tested as a table. The host only applies the
// step it returns.
import { MAX_STATUS_NOTE_LENGTH, REPORTED_STATUSES, type ReportedStatus, type SessionStatus } from "talos-shared";
import { QUEUED_STATUS_TIMEOUT_MS, STATUS_TIMEOUT_MS, STATUS_TOOL_NAME } from "./constants";
import { removeControlCharacters } from "./session-logic";

// none: no ask. queued: asked while busy, starts when the session goes idle.
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
  | { type: "ask"; isIdle: boolean }
  | { type: "idle" }
  | { type: "pre-tool-use"; toolName: string; toolInput: unknown; isSubagent: boolean }
  | { type: "stop" }
  | { type: "person-typed" }
  | { type: "tick" };

// hookReply is the hook's stdout for Claude Code ("" = no decision).
export type StatusLaneStep = { lane: StatusLane; hookReply: string; statusChange: SessionStatus | null; shouldTypeRequest: boolean };

export const STATUS_REQUEST_PROMPT =
  "Give a status update on this session by calling report_status once, with your state and one short line. Do not do anything else.";

const ONLY_REPORT_REASON = "This is a status update — only report_status is allowed this turn.";
const NOT_NOW_REASON = "Not a status update; report_status can't be called now.";
const BAD_REPORT_REASON = `Call report_status with state (${REPORTED_STATUSES.join("/")}) and one short line.`;
const FORCE_REPORT_REASON = "Call report_status with your state and one short line before finishing.";
const HOST_UNREACHABLE_REASON = "talos can't record a status right now.";

export const allowToolDecision = (): string =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });
export const denyToolDecision = (reason: string): string =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
const blockStopDecision = (reason: string): string => JSON.stringify({ decision: "block", reason });

// A note lands in a shared table row and the logs, so it can't carry terminal
// escapes or line breaks.
const cleanStatusNote = (note: string): string => removeControlCharacters(note).replace(/\s+/g, " ").trim();

export const readStatusReport = (toolInput: unknown): { state: ReportedStatus; note: string } | null => {
  if (typeof toolInput !== "object" || toolInput === null) return null;
  const state: unknown = Reflect.get(toolInput, "state");
  const note: unknown = Reflect.get(toolInput, "note");
  const reportedState = REPORTED_STATUSES.find((choice) => choice === state);
  const isShortNote = typeof note === "string" && note.length <= MAX_STATUS_NOTE_LENGTH;
  if (!reportedState || !isShortNote) return null;
  return { state: reportedState, note: cleanStatusNote(note) };
};

const fieldOf = (value: unknown, field: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, field) : undefined;

// The lane event a hook carries, if any. agent_id marks a sub-agent's hook: a
// sub-agent's report_status is not this session's answer.
export const readStatusLaneEvent = (hookDetails: unknown): StatusLaneEvent | null => {
  const hookEvent = fieldOf(hookDetails, "hook_event_name");
  if (hookEvent === "Stop") return { type: "stop" };
  if (hookEvent !== "PreToolUse") return null;
  return {
    type: "pre-tool-use",
    toolName: String(fieldOf(hookDetails, "tool_name") ?? ""),
    toolInput: fieldOf(hookDetails, "tool_input"),
    isSubagent: typeof fieldOf(hookDetails, "agent_id") === "string",
  };
};

// What hook.ts prints when it can't reach the host: deny report_status, so no
// status call runs that nobody records. Every other tool runs, so a host crash
// doesn't freeze the sessions.
export const hookReplyWhenHostUnreachable = (hookDetails: unknown): string => {
  const event = readStatusLaneEvent(hookDetails);
  const isStatusCall = event?.type === "pre-tool-use" && event.toolName === STATUS_TOOL_NAME;
  return isStatusCall ? denyToolDecision(HOST_UNREACHABLE_REASON) : "";
};

const stay = (lane: StatusLane, hookReply = ""): StatusLaneStep => ({ lane, hookReply, statusChange: null, shouldTypeRequest: false });

const startStatusTurn = (nowMs: number, statusChange: SessionStatus | null): StatusLaneStep => ({
  lane: { kind: "asking", askedAtMs: nowMs, hasForcedStop: false },
  hookReply: "",
  statusChange,
  shouldTypeRequest: true,
});

// A repeat ask while one is in flight is ignored: re-arming would reset the
// timeout clock, so a flood of asks could pin a session in status-only mode.
const stepAsk = (lane: StatusLane, isIdle: boolean, nowMs: number): StatusLaneStep => {
  if (lane.kind !== "none") return stay(lane);
  const pending: SessionStatus = { state: "pending", note: "", atMs: nowMs };
  if (isIdle) return startStatusTurn(nowMs, pending);
  return { lane: { kind: "queued", askedAtMs: nowMs }, hookReply: "", statusChange: pending, shouldTypeRequest: false };
};

const stepPreToolUse = (lane: StatusLane, event: Extract<StatusLaneEvent, { type: "pre-tool-use" }>, nowMs: number): StatusLaneStep => {
  const isStatusTool = event.toolName === STATUS_TOOL_NAME;
  if (!isStatusTurnRunning(lane)) return isStatusTool ? stay(lane, denyToolDecision(NOT_NOW_REASON)) : stay(lane);
  if (!isStatusTool) return stay(lane, denyToolDecision(ONLY_REPORT_REASON));
  const report = event.isSubagent ? null : readStatusReport(event.toolInput);
  if (!report) return stay(lane, denyToolDecision(BAD_REPORT_REASON));
  return {
    lane: { kind: "reported", askedAtMs: lane.askedAtMs },
    hookReply: allowToolDecision(),
    statusChange: { ...report, atMs: nowMs },
    shouldTypeRequest: false,
  };
};

// Only a report ends the turn. An unreported Stop is blocked once to force the
// report, then let through, but the turn stays open until a report or the
// timeout, so a forged Stop can't end it early and let another tool run.
const stepStop = (lane: StatusLane): StatusLaneStep => {
  if (lane.kind === "reported") return stay(NO_STATUS_LANE);
  if (lane.kind !== "asking" || lane.hasForcedStop) return stay(lane);
  return stay({ ...lane, hasForcedStop: true }, blockStopDecision(FORCE_REPORT_REASON));
};

// An unanswered ask becomes "no response"; a reported one keeps its status.
const endStatusAsk = (lane: StatusLane, nowMs: number): StatusLaneStep => {
  const noResponse: SessionStatus = { state: "no-response", note: "", atMs: nowMs };
  return { lane: NO_STATUS_LANE, hookReply: "", statusChange: lane.kind === "reported" ? null : noResponse, shouldTypeRequest: false };
};

const isStatusTurnRunning = (lane: StatusLane): lane is Extract<StatusLane, { kind: "asking" | "reported" }> =>
  lane.kind === "asking" || lane.kind === "reported";

// The backstop for an ask that never ends on its own. A queued ask gets far
// longer, since it waits for the session's own work to finish first.
const stepTick = (lane: StatusLane, nowMs: number): StatusLaneStep => {
  if (lane.kind === "none") return stay(lane);
  const timeoutMs = lane.kind === "queued" ? QUEUED_STATUS_TIMEOUT_MS : STATUS_TIMEOUT_MS;
  return nowMs - lane.askedAtMs > timeoutMs ? endStatusAsk(lane, nowMs) : stay(lane);
};

// The person typing ends any ask. Otherwise a queued ask is typed in at the next
// Stop and pulls their message into a status turn, and an Esc (which sends no
// Stop) leaves it pending. Only the control socket sends this, so a session
// can't forge it the way it can forge a Stop.
const stepPersonTyped = (lane: StatusLane, nowMs: number): StatusLaneStep =>
  lane.kind === "none" ? stay(lane) : endStatusAsk(lane, nowMs);

export const stepStatusLane = (lane: StatusLane, event: StatusLaneEvent, nowMs: number): StatusLaneStep => {
  if (event.type === "ask") return stepAsk(lane, event.isIdle, nowMs);
  if (event.type === "idle") return lane.kind === "queued" ? startStatusTurn(nowMs, null) : stay(lane);
  if (event.type === "pre-tool-use") return stepPreToolUse(lane, event, nowMs);
  if (event.type === "stop") return stepStop(lane);
  if (event.type === "person-typed") return stepPersonTyped(lane, nowMs);
  return stepTick(lane, nowMs);
};
