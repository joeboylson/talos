// A session's turns run in one lane at a time. In the prose lane (an ordinary
// chat turn) it may call any tool, plus the structured tools the prose turn
// allows. In an asked-for lane, a turn the session runner starts when someone
// asks for a kind (like a status), it may call that kind's tool and nothing else.
// Every lane change goes through stepLane, a pure function, so the rules live in
// one place and are tested as a table. The session runner only applies the step
// it returns.
import { SESSION_LIMITS } from "../limits";
import { STRUCTURED_TOOL_PREFIX, askedTurn, findKind, findKindByTool, type Catalog, type OutputKind, type TurnShape } from "../kinds";

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
  | { type: "pre-tool-use"; toolName: string; toolInput: unknown; isSubagent: boolean }
  | { type: "stop" }
  | { type: "prompt-submitted"; prompt: string }
  | { type: "person-typed"; isTurnChanging: boolean }
  | { type: "tick" };

export type AskState = "asking" | "answered" | "no-response";
export type RecordedOutput = { kind: string; fields: Record<string, unknown>; atMs: number };

// hookReply is the hook's stdout for Claude Code ("" = no decision).
export type LaneStep = {
  lane: Lane;
  hookReply: string;
  recorded: RecordedOutput | null;
  askChange: { kind: string; state: AskState; atMs: number } | null;
  closesOpenOutputs: boolean;
  requestToType: string | null;
};

const RUNNER_UNREACHABLE_REASON = "talos can't record that right now.";
const TOO_BIG_REASON = "This tool call is too big for talos to check.";
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

const allowToolDecision = (): string =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });
const denyToolDecision = (reason: string): string =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
const blockStopDecision = (reason: string): string => JSON.stringify({ decision: "block", reason });

const fieldOf = (value: unknown, field: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, field) : undefined;

// The lane event a hook carries, if any. agent_id marks a sub-agent's hook.
export const readLaneEvent = (hookDetails: unknown): LaneEvent | null => {
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

// What hook.ts prints when it can't reach the session runner: deny every
// structured tool by its name, so no answer is given that nobody records. Every
// other tool runs, so a session runner crash doesn't freeze the sessions.
export const hookReplyWhenRunnerUnreachable = (hookDetails: unknown): string => {
  const event = readLaneEvent(hookDetails);
  const isStructuredCall = event?.type === "pre-tool-use" && event.toolName.startsWith(STRUCTURED_TOOL_PREFIX);
  return isStructuredCall ? denyToolDecision(RUNNER_UNREACHABLE_REASON) : "";
};

// What hook.ts prints when the session runner turned the hook down as too big to
// read: a tool call talos couldn't check doesn't run, since in an asked-for turn it must not.
export const hookReplyWhenTooBig = (hookDetails: unknown): string =>
  readLaneEvent(hookDetails)?.type === "pre-tool-use" ? denyToolDecision(TOO_BIG_REASON) : "";

const stay = (lane: Lane, hookReply = ""): LaneStep => ({
  lane,
  hookReply,
  recorded: null,
  askChange: null,
  closesOpenOutputs: false,
  requestToType: null,
});


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

// A turn may send what its shape allows; in an asked-for turn, sending its
// output answers it. A turn may send its answer more than once; the last one stands.
const stepStructuredCall = (lane: Lane, kind: OutputKind, toolInput: unknown, nowMs: number, catalog: Catalog): LaneStep => {
  const shape = turnShapeOf(lane, catalog);
  const isOutput = shape.output === kind.kind;
  if (!isOutput && !shape.optional.includes(kind.kind)) {
    return stay(lane, denyToolDecision(isAskedTurnRunning(lane) ? onlyThisReason(askedToolName(lane, catalog)) : notNowReason(kind)));
  }
  const fields = kind.readFields(toolInput);
  if (!fields) return stay(lane, denyToolDecision(kind.badInputReason));
  const recorded = { kind: kind.kind, fields, atMs: nowMs };
  if (!isOutput || !isAskedTurnRunning(lane)) return { ...stay(lane, allowToolDecision()), recorded };
  const answered: Lane = { stage: "answered", output: lane.output, askedAtMs: lane.askedAtMs };
  return { ...stay(answered, allowToolDecision()), recorded, askChange: askChange(kind.kind, "answered", nowMs) };
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
  if (kind) return stepStructuredCall(lane, kind, event.toolInput, nowMs, catalog);
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

// A prompt Claude Code submits is the person's answer to an open output, so it
// closes them; keys alone aren't (Enter also answers a permission prompt or picks
// from a menu). A request talos types isn't an answer. A session can forge this
// for itself, which only closes its own questions.
const stepPromptSubmitted = (lane: Lane, prompt: string, catalog: Catalog): LaneStep => {
  const isRequest = catalog.kinds.some((kind) => kind.requestText !== undefined && prompt.trim() === kind.requestText);
  return isRequest ? stay(lane) : { ...stay(lane), closesOpenOutputs: true };
};

export const stepLane = (lane: Lane, event: LaneEvent, nowMs: number, catalog: Catalog): LaneStep => {
  if (event.type === "ask") return stepAsk(lane, event.kind, nowMs, catalog);
  if (event.type === "settled") return stepSettled(lane, event.hasDraft, nowMs, catalog);
  if (event.type === "pre-tool-use") return stepPreToolUse(lane, event, nowMs, catalog);
  if (event.type === "stop") return stepStop(lane, catalog);
  if (event.type === "person-typed") return stepPersonTyped(lane, event.isTurnChanging, nowMs);
  if (event.type === "prompt-submitted") return stepPromptSubmitted(lane, event.prompt, catalog);
  return stepTick(lane, nowMs);
};
