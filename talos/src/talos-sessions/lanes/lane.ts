// A session's turns run in one lane at a time. In the prose lane (an ordinary
// chat turn) it may call any tool, plus the structured tools the prose turn
// allows. In an asked-for lane, a turn the session runner starts when someone
// asks for a kind (like a status), it may call that kind's tool and nothing else
// (the session's mod denies the rest, see onlyToolOf).
// Every lane change goes through stepLane, a pure function, so the rules live in
// one place and are tested as a table. The session runner only applies the step
// it returns.
import { SESSION_LIMITS } from "../limits";
import { cleanLine, hasCommandMarker } from "../clean";
import { jsonByteLength } from "../shapes";
import { ID_PLACEHOLDER, askedTurn, findKind, findKindByTool, mcpToolName, replyWording, type Catalog, type OutputKind, type TurnShape } from "../kinds";
import type { TakenOutput } from "./outputs";

// none: no ask. queued: asked, starts when the session's turn is over and settled.
// asking: the asked-for turn is running. answered: answered, waiting for the turn to end.
// hasForcedStop: the turn's Stop was already sent back once.
export type Lane =
  | { stage: "none" }
  | { stage: "queued"; output: string; askedAtMs: number }
  | { stage: "asking"; output: string; askedAtMs: number; hasForcedStop: boolean }
  | { stage: "answered"; output: string; askedAtMs: number };

export const NO_LANE: Lane = { stage: "none" };

export type LaneEvent =
  | { type: "ask"; kind: string }
  // The session's turn is over (see runner/session-state.ts): a request sent
  // now starts a turn of its own, and a finished asked-for turn has really ended.
  | { type: "settled"; hasDraft: boolean }
  // A call to one of talos's tools. outputId is a fresh id the caller made,
  // used if the call is allowed.
  | { type: "tool-call"; toolName: string; toolInput: unknown; isSubagent: boolean; toolUseId: string; outputId: string }
  // A structured output was taken (see outputs.ts).
  | { type: "taken"; output: TakenOutput }
  | { type: "stop" }
  | { type: "person-typed"; isTurnChanging: boolean }
  | { type: "tick" };

export type AskState = "asking" | "answered" | "no-response";

// reply answers the mod: a tool call's result or why it's denied, or a Stop
// sent back to keep going (null: no say). sent is the structured output the
// call just handed over.
export type LaneReply = { result: string } | { deny: string } | { block: string } | null;
export type LaneStep = {
  lane: Lane;
  reply: LaneReply;
  sent: TakenOutput | null;
  askChange: { kind: string; state: AskState; atMs: number; latest?: Record<string, unknown> } | null;
  requestToType: string | null;
};

type RunningLane = Extract<Lane, { stage: "asking" | "answered" }>;
const isAskedTurnRunning = (lane: Lane): lane is RunningLane => lane.stage === "asking" || lane.stage === "answered";

// The asked-for kind's tool, as the session calls it. lane.output is always a
// known kind (stepAsk checks it), so the fallback is only for the type.
const askedToolName = (lane: RunningLane, catalog: Catalog) => mcpToolName(findKind(catalog, lane.output)?.toolName ?? lane.output);
const onlyThisReason = (toolName: string) => `Only ${toolName} is allowed this turn.`;
const forceAnswerReason = (kind: OutputKind) => `Call ${mcpToolName(kind.toolName)} before finishing.`;
const notNowReason = (kind: OutputKind) => `${mcpToolName(kind.toolName)} can't be called now.`;
const NOT_THIS_SESSION_REASON = "Only the session itself can call talos's tools, not a sub-agent.";
const NO_SUCH_TOOL_REASON = "talos has no such tool.";

// While an asked-for turn runs, the one tool the session's own turn may call
// (its mod asks, and denies the rest); null otherwise.
export const onlyToolOf = (lane: Lane, catalog: Catalog): string | null => (isAskedTurnRunning(lane) ? askedToolName(lane, catalog) : null);

const stay = (lane: Lane, reply: LaneReply = null): LaneStep => ({ lane, reply, sent: null, askChange: null, requestToType: null });


const turnShapeOf = (lane: Lane, catalog: Catalog): TurnShape =>
  isAskedTurnRunning(lane) ? askedTurn(lane.output) : catalog.proseTurn;

const askChange = (kind: string, state: AskState, atMs: number): LaneStep["askChange"] => ({ kind, state, atMs });

// Every ask queues, even to an idle session, so the request only ever goes in
// once the turn is over. A repeat ask while one is in flight is ignored:
// re-arming would reset the timeout clock, so a flood of asks could pin a
// session in an asked-for turn. Only a kind with a request can be asked for.
const stepAsk = (lane: Lane, kindName: string, nowMs: number, catalog: Catalog): LaneStep => {
  if (lane.stage !== "none" || !findKind(catalog, kindName)?.requestText) return stay(lane);
  return { ...stay({ stage: "queued", output: kindName, askedAtMs: nowMs }), askChange: askChange(kindName, "asking", nowMs) };
};

// Text a click sends into the session as the person's own can't be a command,
// unless the kind allows it. Checked on cleaned text, which is what's sent.
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

// Only a plain object of fields can be kept and shown; anything else a
// program's check gives back is turned down, not lost after it's allowed.
const isPlainFields = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// A turn may send what its shape allows. It's taken with a fresh id, which
// then answers an asked-for turn (see stepTaken).
const stepStructuredCall = (lane: Lane, kind: OutputKind, event: Extract<LaneEvent, { type: "tool-call" }>, nowMs: number, catalog: Catalog): LaneStep => {
  const shape = turnShapeOf(lane, catalog);
  if (shape.output !== kind.kind && !shape.optional.includes(kind.kind)) {
    return stay(lane, { deny: isAskedTurnRunning(lane) ? onlyThisReason(askedToolName(lane, catalog)) : notNowReason(kind) });
  }
  const fields: unknown = kind.readFields(event.toolInput);
  if (!isPlainFields(fields) || hasForbiddenCommand(kind, fields) || isTooBig(fields)) return stay(lane, { deny: kind.badInputReason });
  const sent = { id: event.outputId, toolUseId: event.toolUseId, kind: kind.kind, fields, atMs: nowMs, waits: kind.waits };
  return { ...stay(lane, { result: replyWording(kind).replace(ID_PLACEHOLDER, event.outputId) }), sent };
};

// Sending an asked-for turn's output answers it. A turn may answer more than
// once; the last one stands.
const stepTaken = (lane: Lane, output: TakenOutput, nowMs: number): LaneStep => {
  if (!isAskedTurnRunning(lane) || lane.output !== output.kind) return stay(lane);
  const answered: Lane = { stage: "answered", output: lane.output, askedAtMs: lane.askedAtMs };
  return { ...stay(answered), askChange: { kind: output.kind, state: "answered", atMs: nowMs, latest: output.fields } };
};

// A sub-agent can't start in an asked-for turn (its tool is denied there), so
// one running now is chat work started earlier: its answer wouldn't be this
// session's own.
const stepToolCall = (lane: Lane, event: Extract<LaneEvent, { type: "tool-call" }>, nowMs: number, catalog: Catalog): LaneStep => {
  if (event.isSubagent) return stay(lane, { deny: NOT_THIS_SESSION_REASON });
  const kind = findKindByTool(catalog, event.toolName);
  return kind ? stepStructuredCall(lane, kind, event, nowMs, catalog) : stay(lane, { deny: NO_SUCH_TOOL_REASON });
};

// A Stop never ends an asked-for turn: the turn stays limited to its kind's
// tool until it's over, the person types, or the backstop runs out. An
// unanswered Stop is sent back once to force the answer.
const stepStop = (lane: Lane, catalog: Catalog): LaneStep => {
  if (lane.stage !== "asking" || lane.hasForcedStop) return stay(lane);
  const kind = findKind(catalog, lane.output);
  return stay({ ...lane, hasForcedStop: true }, kind ? { block: forceAnswerReason(kind) } : null);
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
// answer.
const stepPersonTyped = (lane: Lane, isTurnChanging: boolean, nowMs: number): LaneStep => {
  if (lane.stage === "none") return stay(lane);
  const endsAsk = lane.stage === "queued" || isTurnChanging;
  return endsAsk ? endAsk(lane, nowMs) : stay(lane);
};

export const stepLane = (lane: Lane, event: LaneEvent, nowMs: number, catalog: Catalog): LaneStep => {
  if (event.type === "ask") return stepAsk(lane, event.kind, nowMs, catalog);
  if (event.type === "settled") return stepSettled(lane, event.hasDraft, nowMs, catalog);
  if (event.type === "tool-call") return stepToolCall(lane, event, nowMs, catalog);
  if (event.type === "stop") return stepStop(lane, catalog);
  if (event.type === "person-typed") return stepPersonTyped(lane, event.isTurnChanging, nowMs);
  if (event.type === "taken") return stepTaken(lane, event.output, nowMs);
  return stepTick(lane, nowMs);
};
