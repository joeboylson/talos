// A session's structured outputs, from the call that sends one to the answer
// that closes it. Pure, like the lane: the session runner applies what it returns.
//
// pending: the call was allowed and given an id, but hasn't gone through yet.
// open: it went through with its id (PostToolUse), and waits for an answer.
// An output opens only if the session saw its id: another PreToolUse hook can
// replace the call's input, and then the id is gone. A question lasts one turn:
// it closes when the turn after the one that asked it ends.
import { OUTPUT_ID_FIELD } from "../kinds";
import { SESSION_LIMITS } from "../limits";

export type PendingOutput = { id: string; toolUseId: string; kind: string; fields: Record<string, unknown>; atMs: number; waits: boolean };
export type OpenOutput = { id: string; kind: string; fields: Record<string, unknown>; atMs: number; askedInTurn: number };
export type Outputs = { turn: number; pending: PendingOutput[]; open: OpenOutput[] };

export const NO_OUTPUTS: Outputs = { turn: 0, pending: [], open: [] };

export type OutputsEvent =
  | { type: "sent"; output: PendingOutput }
  | { type: "went-through"; toolUseId: string; toolInput: unknown }
  | { type: "failed"; toolUseId: string }
  | { type: "turn-started" }
  | { type: "turn-ended" }
  | { type: "answered"; id: string };

// opened: the output that just went through, for the lane to count.
export type OutputsStep = { outputs: Outputs; opened: PendingOutput | null; closedIds: string[] };

const step = (outputs: Outputs, opened: PendingOutput | null = null, closedIds: string[] = []): OutputsStep => ({ outputs, opened, closedIds });

const idOf = (toolInput: unknown): unknown =>
  typeof toolInput === "object" && toolInput !== null ? Reflect.get(toolInput, OUTPUT_ID_FIELD) : undefined;

// Oldest closed first past the cap, so one session can't grow its list for good.
const withOpened = (open: OpenOutput[], output: OpenOutput): { open: OpenOutput[]; closedIds: string[] } => {
  const all = [...open, output];
  const overflow = Math.max(all.length - SESSION_LIMITS.maxOpenOutputs, 0);
  return { open: all.slice(overflow), closedIds: all.slice(0, overflow).map(({ id }) => id) };
};

const stepWentThrough = (outputs: Outputs, toolUseId: string, toolInput: unknown): OutputsStep => {
  const sent = outputs.pending.find((output) => output.toolUseId === toolUseId);
  if (!sent) return step(outputs);
  const pending = outputs.pending.filter((output) => output !== sent);
  if (idOf(toolInput) !== sent.id) return step({ ...outputs, pending });
  if (!sent.waits) return step({ ...outputs, pending }, sent);
  const { id, kind, fields, atMs } = sent;
  const { open, closedIds } = withOpened(outputs.open, { id, kind, fields, atMs, askedInTurn: outputs.turn });
  return step({ ...outputs, pending, open }, sent, closedIds);
};

const closeWhere = (outputs: Outputs, isClosing: (output: OpenOutput) => boolean): OutputsStep => {
  const closedIds = outputs.open.filter(isClosing).map(({ id }) => id);
  return closedIds.length === 0 ? step(outputs) : step({ ...outputs, open: outputs.open.filter((output) => !isClosing(output)) }, null, closedIds);
};

const fieldOf = (value: unknown, field: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, field) : undefined;

// The outputs event a hook carries, if any. A Stop the lane blocked isn't the
// end of the turn.
export const readOutputsEvent = (hookDetails: unknown, isBlockedStop: boolean): OutputsEvent | null => {
  const hookEvent = fieldOf(hookDetails, "hook_event_name");
  const toolUseId = String(fieldOf(hookDetails, "tool_use_id") ?? "");
  if (hookEvent === "PostToolUse") return { type: "went-through", toolUseId, toolInput: fieldOf(hookDetails, "tool_input") };
  if (hookEvent === "PostToolUseFailure") return { type: "failed", toolUseId };
  if (hookEvent === "UserPromptSubmit") return { type: "turn-started" };
  if (hookEvent === "Stop" && !isBlockedStop) return { type: "turn-ended" };
  return null;
};

export const stepOutputs = (outputs: Outputs, event: OutputsEvent): OutputsStep => {
  if (event.type === "sent") return step({ ...outputs, pending: [...outputs.pending, event.output].slice(-SESSION_LIMITS.maxOpenOutputs) });
  if (event.type === "went-through") return stepWentThrough(outputs, event.toolUseId, event.toolInput);
  if (event.type === "failed") return step({ ...outputs, pending: outputs.pending.filter((output) => output.toolUseId !== event.toolUseId) });
  // A call with no PostToolUse by the next turn never went through: the
  // person's own rule denied it, or the turn was interrupted.
  if (event.type === "turn-started") return step({ ...outputs, turn: outputs.turn + 1, pending: [] });
  if (event.type === "turn-ended") return closeWhere(outputs, (output) => output.askedInTurn < outputs.turn);
  return closeWhere(outputs, (output) => output.id === event.id);
};
