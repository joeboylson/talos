// A session's turns run in one lane at a time. In the prose lane (an ordinary
// chat turn) it may call any tool, plus the structured tools the prose turn
// allows. In an asked-for lane, a turn the session runner starts when someone
// asks for a kind (like a status), it may call that kind's tool and nothing else.
// Every lane change goes through stepLane, a pure function, so the rules live in
// one place and are tested as a table. The session runner only applies the step
// it returns.
import { SESSION_LIMITS } from "../limits";
import { cleanLine, hasCommandMarker } from "../clean";
import { parseJsonOrNull } from "../json";
import { jsonByteLength } from "../shapes";
import { OUTPUT_ID_FIELD, STRUCTURED_TOOL_PREFIX, askedTurn, findKind, findKindByTool, type Catalog, type OutputKind, type TurnShape } from "../kinds";
import type { PendingOutput } from "./outputs";

// none: no ask. queued: asked, starts when the session's turn is over and settled.
// asking: the asked-for turn is running. answered: answered, waiting for the turn to end.
// hasForcedStop is kept here rather than read from the hook body's
// stop_hook_active, which a session can forge over its own hook token.
export type Lane =
  | { stage: "none" }
  | { stage: "queued"; output: string; askedAtMs: number }
  | { stage: "asking"; output: string; askedAtMs: number; hasForcedStop: boolean }
  | { stage: "answered"; output: string; askedAtMs: number };

export const NO_LANE: Lane = { stage: "none" };

export type LaneEvent =
  | { type: "ask"; kind: string }
  // The session's turn is over and its screen has settled (see
  // runner/session-state.ts): a request typed now starts a turn of its own, and a
  // finished asked-for turn has really ended.
  | { type: "settled"; hasDraft: boolean }
  // outputId is a fresh id the caller made, used if the call is a structured
  // output that's allowed.
  | { type: "pre-tool-use"; toolName: string; toolInput: unknown; isSubagent: boolean; toolUseId: string; outputId: string }
  // A structured output went through with its id (see outputs.ts).
  | { type: "went-through"; output: PendingOutput }
  | { type: "stop" }
  | { type: "person-typed"; isTurnChanging: boolean }
  | { type: "tick" };

export type AskState = "asking" | "answered" | "no-response";

// hookReply is the hook's stdout for Claude Code ("" = no decision). sent is a
// structured output just allowed, pending until it goes through.
export type LaneStep = {
  lane: Lane;
  hookReply: string;
  sent: PendingOutput | null;
  askChange: { kind: string; state: AskState; atMs: number; latest?: Record<string, unknown> } | null;
  requestToType: string | null;
};

const RUNNER_UNREACHABLE_REASON = "talos can't record that right now.";
const TOO_BIG_REASON = "talos couldn't check this tool call (too big, or no answer in time); try again.";
type RunningLane = Extract<Lane, { stage: "asking" | "answered" }>;
const isAskedTurnRunning = (lane: Lane): lane is RunningLane => lane.stage === "asking" || lane.stage === "answered";

// The asked-for kind's tool, named for the session. lane.output is always a known
// kind (stepAsk checks it), so the fallback is only for the type.
const askedToolName = (lane: RunningLane, catalog: Catalog) => findKind(catalog, lane.output)?.toolName ?? lane.output;
const onlyThisReason = (toolName: string) => `Only ${toolName} is allowed this turn.`;
const forceAnswerReason = (kind: OutputKind) => `Call ${kind.toolName} before finishing.`;
const notNowReason = (kind: OutputKind) => `${kind.toolName} can't be called now.`;
const notThisSessionReason = (kind: OutputKind) => `Only the session itself can call ${kind.toolName}, not a sub-agent.`;

// Claude Code loads an MCP tool's fields only when the session looks it up with
// ToolSearch, so an asked-for turn lets it run: it only reads tool descriptions,
// and without it the session can't see the fields of the tool it must call.
const TOOL_SEARCH = "ToolSearch";

// The id goes to the MCP server in the call's input, which it echoes back to the session.
const allowWithIdDecision = (fields: Record<string, unknown>, id: string): string =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...fields, [OUTPUT_ID_FIELD]: id } } });
const denyToolDecision = (reason: string): string =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
const blockStopDecision = (reason: string): string => JSON.stringify({ decision: "block", reason });

const fieldOf = (value: unknown, field: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, field) : undefined;

// The lane event a hook carries, if any. agent_id marks a sub-agent's hook.
// outputId is the fresh id a structured output gets if it's allowed.
export const readLaneEvent = (hookDetails: unknown, outputId = ""): LaneEvent | null => {
  const hookEvent = fieldOf(hookDetails, "hook_event_name");
  if (hookEvent === "Stop") return { type: "stop" };
  if (hookEvent !== "PreToolUse") return null;
  return {
    type: "pre-tool-use",
    toolName: String(fieldOf(hookDetails, "tool_name") ?? ""),
    toolInput: fieldOf(hookDetails, "tool_input"),
    isSubagent: typeof fieldOf(hookDetails, "agent_id") === "string",
    toolUseId: String(fieldOf(hookDetails, "tool_use_id") ?? ""),
    outputId,
  };
};

// What hook.ts prints when it can't reach the session runner: deny every
// structured tool by its name, so no answer is given that nobody records. Every
// other tool runs, so a session runner crash doesn't freeze the sessions.
export const hookReplyWhenRunnerUnreachable = (hookDetails: unknown): string => {
  const event = readLaneEvent(hookDetails);
  const isStructuredCall = event?.type === "pre-tool-use" && event.toolName.startsWith(STRUCTURED_TOOL_PREFIX);
  return isStructuredCall ? denyToolDecision(RUNNER_UNREACHABLE_REASON) : "";
};

// The reply hook.ts prints for the session runner's answer. A structured call
// runs only if the session runner explicitly allowed it with an id; any other
// answer (a bad token, an error, nothing) denies it.
export const hookReplyFromRunner = (hookDetails: unknown, reply: string): string => {
  const event = readLaneEvent(hookDetails);
  if (event?.type !== "pre-tool-use" || !event.toolName.startsWith(STRUCTURED_TOOL_PREFIX)) return reply;
  const decision = fieldOf(fieldOf(parseJsonOrNull(reply), "hookSpecificOutput"), "permissionDecision");
  const id = fieldOf(fieldOf(fieldOf(parseJsonOrNull(reply), "hookSpecificOutput"), "updatedInput"), OUTPUT_ID_FIELD);
  const isAllowedWithId = decision === "allow" && typeof id === "string" && id.length > 0;
  return isAllowedWithId || decision === "deny" ? reply : denyToolDecision(RUNNER_UNREACHABLE_REASON);
};

// What hook.ts prints when the session runner turned the hook down as too big to
// read, or didn't answer it: a tool call talos couldn't check doesn't run, since
// in an asked-for turn it must not.
export const hookReplyWhenTooBig = (hookDetails: unknown): string =>
  readLaneEvent(hookDetails)?.type === "pre-tool-use" ? denyToolDecision(TOO_BIG_REASON) : "";

const stay = (lane: Lane, hookReply = ""): LaneStep => ({ lane, hookReply, sent: null, askChange: null, requestToType: null });


const turnShapeOf = (lane: Lane, catalog: Catalog): TurnShape =>
  isAskedTurnRunning(lane) ? askedTurn(lane.output) : catalog.proseTurn;

const askChange = (kind: string, state: AskState, atMs: number): LaneStep["askChange"] => ({ kind, state, atMs });

// Every ask queues, even to an idle session, so the request is only ever typed
// once the turn is over. A repeat ask while one is in flight is ignored:
// re-arming would reset the timeout clock, so a flood of asks could pin a
// session in an asked-for turn. Only a kind with a request can be asked for.
const stepAsk = (lane: Lane, kindName: string, nowMs: number, catalog: Catalog): LaneStep => {
  if (lane.stage !== "none" || !findKind(catalog, kindName)?.requestText) return stay(lane);
  return { ...stay({ stage: "queued", output: kindName, askedAtMs: nowMs }), askChange: askChange(kindName, "asking", nowMs) };
};

// Text a click or the person could type into the session can't be a command,
// unless the kind allows it. Checked on cleaned text, which is what gets typed.
const typedTextOf = (value: unknown): string[] | null => {
  if (typeof value === "string") return [value];
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
};
const hasForbiddenCommand = (kind: OutputKind, fields: Record<string, unknown>): boolean =>
  Object.entries(kind.typedFields).some(([field, { allowCommands }]) => {
    const texts = typedTextOf(fields[field]);
    return texts === null || (!allowCommands && texts.some((text) => hasCommandMarker(cleanLine(text))));
  });
const isTooBig = (fields: Record<string, unknown>): boolean => jsonByteLength(fields) > SESSION_LIMITS.maxOutputFieldsBytes;

// A turn may send what its shape allows. It's allowed with a fresh id and stays
// pending; an asked-for turn is answered only once it goes through.
const stepStructuredCall = (lane: Lane, kind: OutputKind, event: Extract<LaneEvent, { type: "pre-tool-use" }>, nowMs: number, catalog: Catalog): LaneStep => {
  const shape = turnShapeOf(lane, catalog);
  if (shape.output !== kind.kind && !shape.optional.includes(kind.kind)) {
    return stay(lane, denyToolDecision(isAskedTurnRunning(lane) ? onlyThisReason(askedToolName(lane, catalog)) : notNowReason(kind)));
  }
  const fields = kind.readFields(event.toolInput);
  if (!fields || hasForbiddenCommand(kind, fields) || isTooBig(fields)) return stay(lane, denyToolDecision(kind.badInputReason));
  const sent = { id: event.outputId, toolUseId: event.toolUseId, kind: kind.kind, fields, atMs: nowMs, waits: kind.waits };
  return { ...stay(lane, allowWithIdDecision(fields, event.outputId)), sent };
};

// Sending an asked-for turn's output answers it. A turn may answer more than
// once; the last one stands.
const stepWentThrough = (lane: Lane, output: PendingOutput, nowMs: number): LaneStep => {
  if (!isAskedTurnRunning(lane) || lane.output !== output.kind) return stay(lane);
  const answered: Lane = { stage: "answered", output: lane.output, askedAtMs: lane.askedAtMs };
  return { ...stay(answered), askChange: { kind: output.kind, state: "answered", atMs: nowMs, latest: output.fields } };
};

const stepPreToolUse = (lane: Lane, event: Extract<LaneEvent, { type: "pre-tool-use" }>, nowMs: number, catalog: Catalog): LaneStep => {
  const kind = findKindByTool(catalog, event.toolName);
  // A sub-agent can't start in an asked-for turn (its tool is denied there), so
  // one running now is chat work started earlier: it keeps every tool but the
  // structured ones, whose answer wouldn't be this session's own.
  if (event.isSubagent) {
    const isStructured = event.toolName.startsWith(STRUCTURED_TOOL_PREFIX);
    return isStructured ? stay(lane, denyToolDecision(kind ? notThisSessionReason(kind) : RUNNER_UNREACHABLE_REASON)) : stay(lane);
  }
  if (kind) return stepStructuredCall(lane, kind, event, nowMs, catalog);
  if (!isAskedTurnRunning(lane) || event.toolName === TOOL_SEARCH) return stay(lane);
  return stay(lane, denyToolDecision(onlyThisReason(askedToolName(lane, catalog))));
};

// A Stop never ends an asked-for turn: a session can forge one, so the turn stays
// limited to its kind's tool until its screen settles with the turn over, the
// person types, or the backstop runs out. An unanswered Stop is blocked once to
// force the answer.
const stepStop = (lane: Lane, catalog: Catalog): LaneStep => {
  if (lane.stage !== "asking" || lane.hasForcedStop) return stay(lane);
  const kind = findKind(catalog, lane.output);
  return stay({ ...lane, hasForcedStop: true }, kind ? blockStopDecision(forceAnswerReason(kind)) : "");
};

// An unanswered ask becomes "no response"; an answered one keeps its answer.
const endAsk = (lane: Exclude<Lane, { stage: "none" }>, nowMs: number): LaneStep => ({
  ...stay(NO_LANE),
  askChange: lane.stage === "answered" ? null : askChange(lane.output, "no-response", nowMs),
});

// Settled: a queued ask is typed now (unless a draft is waiting, which the
// request would be sent along with), and an answered turn ends.
const stepSettled = (lane: Lane, hasDraft: boolean, nowMs: number, catalog: Catalog): LaneStep => {
  if (lane.stage === "answered") return stay(NO_LANE);
  if (lane.stage !== "queued") return stay(lane);
  if (hasDraft) return endAsk(lane, nowMs);
  const requestToType = findKind(catalog, lane.output)?.requestText ?? null;
  return { ...stay({ stage: "asking", output: lane.output, askedAtMs: nowMs, hasForcedStop: false }), requestToType };
};

// The backstops. An unanswered turn becomes "no response" but stays limited (as
// answered, so a late answer still counts) until it settles, since the turn
// itself may still be running. A queued ask, or a turn that never settles, ends
// after the long wait.
const stepTick = (lane: Lane, nowMs: number): LaneStep => {
  if (lane.stage === "none") return stay(lane);
  const waitedMs = nowMs - lane.askedAtMs;
  if (lane.stage === "asking" && waitedMs > SESSION_LIMITS.askTimeoutMs) {
    return { ...stay({ stage: "answered", output: lane.output, askedAtMs: lane.askedAtMs }), askChange: askChange(lane.output, "no-response", nowMs) };
  }
  return waitedMs > SESSION_LIMITS.queuedAskTimeoutMs ? endAsk(lane, nowMs) : stay(lane);
};

// The person typing ends a queued ask: it would otherwise be pasted after their
// draft and pull it into an asked-for turn, and an Esc (which sends no Stop)
// would leave it waiting. A running asked-for turn ends only on a turn-changing
// key (Enter, Esc, Ctrl-C), so watching it with arrow keys doesn't lose the
// answer. Only the control socket sends this, so a session can't forge it the
// way it can forge a Stop.
const stepPersonTyped = (lane: Lane, isTurnChanging: boolean, nowMs: number): LaneStep => {
  if (lane.stage === "none") return stay(lane);
  const endsAsk = lane.stage === "queued" || isTurnChanging;
  return endsAsk ? endAsk(lane, nowMs) : stay(lane);
};

export const stepLane = (lane: Lane, event: LaneEvent, nowMs: number, catalog: Catalog): LaneStep => {
  if (event.type === "ask") return stepAsk(lane, event.kind, nowMs, catalog);
  if (event.type === "settled") return stepSettled(lane, event.hasDraft, nowMs, catalog);
  if (event.type === "pre-tool-use") return stepPreToolUse(lane, event, nowMs, catalog);
  if (event.type === "stop") return stepStop(lane, catalog);
  if (event.type === "person-typed") return stepPersonTyped(lane, event.isTurnChanging, nowMs);
  if (event.type === "went-through") return stepWentThrough(lane, event.output, nowMs);
  return stepTick(lane, nowMs);
};
