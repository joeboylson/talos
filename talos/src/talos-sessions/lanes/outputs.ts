// A session's structured outputs, from the call that sends one to the answer
// that closes it. Pure, like the lane: the session runner applies what it returns.
//
// An output is taken the moment the session's mod answers its call. One that
// waits stays open for an answer. A question lasts one turn: it closes when
// the person's turn after the one that asked it ends. Turns talos sends
// (answers, asked-for requests) and turns Claude Code starts on its own don't
// count, so answering one question doesn't close the next.
import { SESSION_LIMITS } from "../limits";

export type TakenOutput = { id: string; toolUseId: string; kind: string; fields: Record<string, unknown>; atMs: number; waits: boolean };
export type OpenOutput = { id: string; kind: string; fields: Record<string, unknown>; atMs: number; askedInTurn: number };
// turn counts the person's turns that have ended; isPersonTurn says the running one is theirs.
export type Outputs = { turn: number; isPersonTurn: boolean; open: OpenOutput[] };

export const NO_OUTPUTS: Outputs = { turn: 0, isPersonTurn: false, open: [] };

export type OutputsEvent =
  | { type: "sent"; output: TakenOutput }
  | { type: "turn-started"; isPersonTurn: boolean }
  | { type: "turn-ended" }
  | { type: "answered"; id: string };

// opened: the output just taken, for the lane to count.
export type OutputsStep = { outputs: Outputs; opened: TakenOutput | null; closedIds: string[] };

const step = (outputs: Outputs, opened: TakenOutput | null = null, closedIds: string[] = []): OutputsStep => ({ outputs, opened, closedIds });

// Oldest closed first past the cap, so one session can't grow its list for good.
const withOpened = (open: OpenOutput[], output: OpenOutput): { open: OpenOutput[]; closedIds: string[] } => {
  const all = [...open, output];
  const overflow = Math.max(all.length - SESSION_LIMITS.maxOpenOutputs, 0);
  return { open: all.slice(overflow), closedIds: all.slice(0, overflow).map(({ id }) => id) };
};

const stepSent = (outputs: Outputs, sent: TakenOutput): OutputsStep => {
  if (!sent.waits) return step(outputs, sent);
  const { id, kind, fields, atMs } = sent;
  const { open, closedIds } = withOpened(outputs.open, { id, kind, fields, atMs, askedInTurn: outputs.turn });
  return step({ ...outputs, open }, sent, closedIds);
};

const closeWhere = (outputs: Outputs, isClosing: (output: OpenOutput) => boolean): OutputsStep => {
  const closedIds = outputs.open.filter(isClosing).map(({ id }) => id);
  return closedIds.length === 0 ? step(outputs) : step({ ...outputs, open: outputs.open.filter((output) => !isClosing(output)) }, null, closedIds);
};

export const stepOutputs = (outputs: Outputs, event: OutputsEvent): OutputsStep => {
  if (event.type === "sent") return stepSent(outputs, event.output);
  if (event.type === "turn-started") return step({ ...outputs, isPersonTurn: event.isPersonTurn });
  if (event.type === "turn-ended") {
    if (!outputs.isPersonTurn) return step(outputs);
    const closed = closeWhere(outputs, (output) => output.askedInTurn < outputs.turn);
    return { ...closed, outputs: { ...closed.outputs, turn: outputs.turn + 1, isPersonTurn: false } };
  }
  return closeWhere(outputs, (output) => output.id === event.id);
};

// An output sent in a normal turn shows in the conversation in its call's place.
// Its two halves arrive apart: the output is taken (through the mod), and the
// call is read from the conversation. Whichever comes first waits for the other, each
// list capped on its own (see limits.ts).
export type CallPlace = { toolUseId: string; position: number };
export type OutputPlacing = { waitingOutputs: TakenOutput[]; waitingPlaces: CallPlace[] };
export const NO_PLACING: OutputPlacing = { waitingOutputs: [], waitingPlaces: [] };

export const placeOutputs = (
  placing: OutputPlacing,
  arrivedOutputs: readonly TakenOutput[],
  arrivedPlaces: readonly CallPlace[],
): { placing: OutputPlacing; placed: { output: TakenOutput; position: number }[] } => {
  const outputs = [...placing.waitingOutputs, ...arrivedOutputs];
  const places = [...placing.waitingPlaces, ...arrivedPlaces];
  const placed = outputs.flatMap((output) => {
    const place = places.find(({ toolUseId }) => toolUseId === output.toolUseId);
    return place ? [{ output, position: place.position }] : [];
  });
  const placedIds = new Set(placed.map(({ output }) => output.toolUseId));
  return {
    placing: {
      waitingOutputs: outputs.filter(({ toolUseId }) => !placedIds.has(toolUseId)).slice(-SESSION_LIMITS.maxOutputsInFlight),
      waitingPlaces: places.filter(({ toolUseId }) => !placedIds.has(toolUseId)).slice(-SESSION_LIMITS.maxWaitingPlaces),
    },
    placed,
  };
};
