// A session's state and its lane: every change to either goes through here.
import { mergeSessionEntries, type SessionEntry, type SessionState, type SessionSummary } from "../shapes";
import { steadyNow } from "../constants";
import { findKind } from "../kinds";
import { stepLane, type LaneEvent, type LaneStep } from "../lanes/lane";
import { placeOutputs, stepOutputs, type CallPlace, type Outputs, type OutputsEvent, type PendingOutput } from "../lanes/outputs";
import { SESSION_LIMITS } from "../limits";
import { keptHeld, nextToType, readAnswer, type HeldAnswer } from "../lanes/held";
import { catalog, log } from "./inputs";
import { noSuchSession, refuse } from "./refuse";
import { broadcast, broadcastSessions, heldSessions, updateHeldSession, type HeldSession } from "./store";
import { dropOldImages, refuseLinkLost } from "./messages";
import { submitThroughMod } from "./submit";

// The summary shows each ask's state and latest answer, and the open outputs.
const withAsk = (summary: SessionSummary, change: LaneStep["askChange"]): SessionSummary => {
  if (!change) return summary;
  const { kind, state, atMs, latest } = change;
  const kept = summary.asks[kind]?.latest;
  const ask = { state, atMs, ...((latest ?? kept) && { latest: latest ?? kept }) };
  return { ...summary, asks: { ...summary.asks, [kind]: ask } };
};
// The summary shows the newest open outputs that fit its budget, so a session
// can't grow the list it sends with every change.
const withOpenOutputs = (summary: SessionSummary, outputs: Outputs): SessionSummary => {
  const shown = outputs.open.map(({ id, kind, fields, atMs }) => ({ id, kind, fields, atMs }));
  const sizes = shown.map((output) => JSON.stringify(output).length);
  const firstShown = sizes.findIndex((_size, index) => sizes.slice(index).reduce((total, size) => total + size, 0) <= SESSION_LIMITS.maxSummaryOutputsBytes);
  return { ...summary, openOutputs: firstShown === -1 ? [] : shown.slice(firstShown) };
};

const toOutputEntry = ({ output: { id, kind, fields }, position }: { output: PendingOutput; position: number }): SessionEntry => ({
  kind: "output",
  entryId: id,
  outputKind: kind,
  fields,
  position,
});

// Adds outputs to the conversation once both halves are in (see placeOutputs).
export const placeOutputEntries = (sessionName: string, arrivedOutputs: PendingOutput[], arrivedPlaces: CallPlace[]): void => {
  const session = heldSessions.get(sessionName);
  if (!session || (arrivedOutputs.length === 0 && arrivedPlaces.length === 0)) return;
  const { placing, placed } = placeOutputs(session.placing, arrivedOutputs, arrivedPlaces);
  const outputEntries = placed.map(toOutputEntry);
  const entries = outputEntries.length > 0 ? mergeSessionEntries(session.entries, outputEntries, SESSION_LIMITS.maxEntriesKept) : session.entries;
  saveSession(sessionName, session, { placing, entries });
  if (outputEntries.length > 0) broadcast({ type: "session-entries", sessionName, entries: outputEntries });
};

const saveSession = (sessionName: string, session: HeldSession, changes: Partial<HeldSession>): void => {
  const next = { ...session, ...changes };
  heldSessions.set(sessionName, next);
  if (next.summary !== session.summary) broadcastSessions();
};

// What talos itself sends (a request, an answer) goes in framed as the talos
// mod's, only once the turn is over, and starts a turn: nothing else talos
// holds goes in until that turn is over too. False when there's no link.
// shortcut: if what's sent never starts a turn (dropped with no fact back),
// nothing else talos holds goes in until the next turn ends.
const submitTalosText = (sessionName: string, session: HeldSession, text: string): boolean => {
  const current = heldSessions.get(sessionName);
  const sendInFlight = current?.hookToken === session.hookToken ? submitThroughMod(current, text, false) : null;
  if (!sendInFlight) return false;
  updateHeldSession(sessionName, session.hookToken, { isTalosTypedNext: true, isTurnOver: false, sendInFlight });
  return true;
};

const notify = (sessionName: string, dropped: readonly HeldAnswer[]): void => {
  if (dropped.length > 0) broadcast({ type: "notice", sessionName, message: "An answer was dropped: its question closed, or the session never settled" });
};

// Every lane change goes through here: step the lane, then apply what the step
// says (an output sent, an ask's change, a typed request) and return the hook's reply.
export const applyLaneEvent = (sessionName: string, event: LaneEvent): string => {
  const session = heldSessions.get(sessionName);
  if (!session) return "";
  const nowMs = steadyNow();
  const step = stepLane(session.lane, event, nowMs, catalog());
  const outputs = step.sent ? stepOutputs(session.outputs, { type: "sent", output: step.sent }).outputs : session.outputs;
  const heldAnswers = event.type === "tick" ? keptHeld(session.heldAnswers, [], nowMs) : session.heldAnswers;
  const isPersonTurn = event.type === "person-typed" && event.isTurnChanging;
  const isTalosTypedNext = session.isTalosTypedNext && !isPersonTurn;
  saveSession(sessionName, session, { lane: step.lane, outputs, heldAnswers, isTalosTypedNext, summary: withAsk(session.summary, step.askChange) });
  notify(sessionName, session.heldAnswers.filter((answer) => !heldAnswers.includes(answer)));
  // A request that can't go in (no link) ends its ask.
  if (step.requestToType && !submitTalosText(sessionName, session, step.requestToType)) {
    applyLaneEvent(sessionName, { type: "person-typed", isTurnChanging: true });
  }
  // A lane or answer left waiting to settle while the turn is already over gets
  // its wait now, not only when the session's state next changes.
  if (isWaitingToSettle(heldSessions.get(sessionName)) && session.isTurnOver) stepLaneWhenSettled(sessionName, session.hookToken);
  return step.hookReply;
};

// Every change to the outputs goes through here. One that went through tells the
// lane, which counts it as an asked-for turn's answer.
export const applyOutputsEvent = (sessionName: string, event: OutputsEvent): void => {
  const session = heldSessions.get(sessionName);
  if (!session) return;
  const step = stepOutputs(session.outputs, event);
  if (step.outputs === session.outputs) return;
  const summary = step.outputs.open === session.outputs.open ? session.summary : withOpenOutputs(session.summary, step.outputs);
  const heldAnswers = keptHeld(session.heldAnswers, step.closedIds, steadyNow());
  saveSession(sessionName, session, { outputs: step.outputs, summary, heldAnswers });
  // An output sent in a normal turn shows in the conversation too. An asked-for
  // kind's answer shows in the summary only.
  if (step.opened && !findKind(catalog(), step.opened.kind)?.requestText) placeOutputEntries(sessionName, [step.opened], []);
  notify(sessionName, session.heldAnswers.filter((answer) => !heldAnswers.includes(answer)));
  if (step.opened) applyLaneEvent(sessionName, { type: "went-through", output: step.opened });
};

// isTurnOver says the turn ended (idle, or waiting on a decision's answer); a
// "needs you" for a permission prompt is mid-turn.
export const setSessionState = (sessionName: string, state: SessionState, isTurnOver = state === "idle") => {
  const session = heldSessions.get(sessionName);
  if (!session || (session.summary.state === state && session.isTurnOver === isTurnOver)) return;
  heldSessions.set(sessionName, { ...session, isTurnOver, summary: { ...session.summary, state, isTurnOver } });
  log.detail(`runner: ${sessionName} is ${state}`);
  broadcastSessions();
  if (isTurnOver) stepLaneWhenSettled(sessionName, session.hookToken);
};

// Messages sent while it started wait for the start.
const hasWaitingMessages = (session: HeldSession): boolean => session.queuedMessages.length > 0 && session.summary.state !== "starting";
const isWaitingToSettle = (session: HeldSession | undefined): boolean =>
  session !== undefined && (session.lane.stage === "queued" || session.lane.stage === "answered" || session.heldAnswers.length > 0 || hasWaitingMessages(session));

// The person's oldest waiting message goes in first, in their own words: it
// ends any ask, and the session works on it. Its images' older ones go then.
const submitWaitingMessage = (sessionName: string, session: HeldSession): void => {
  const [next, ...rest] = session.queuedMessages;
  const sendInFlight = next ? submitThroughMod(session, next.text, true) : null;
  if (!next || !sendInFlight) return;
  updateHeldSession(sessionName, session.hookToken, { queuedMessages: rest, isTurnOver: false, sendInFlight });
  applyLaneEvent(sessionName, { type: "person-typed", isTurnChanging: true });
  void dropOldImages(sessionName, next.imagePaths).catch(() => {});
};

// Once the turn is over: a waiting message, else a finished asked-for turn
// ends, then the oldest of a queued ask and the held answers goes in. One per
// turn: what goes in starts a turn, and the next goes in once that one is over.
const sendNextWhenSettled = (sessionName: string): void => {
  const session = heldSessions.get(sessionName);
  if (!session) return;
  if (hasWaitingMessages(session)) return submitWaitingMessage(sessionName, session);
  if (session.lane.stage === "answered") applyLaneEvent(sessionName, { type: "settled", hasDraft: session.hasDraft });
  const current = heldSessions.get(sessionName);
  if (!current) return;
  const next = nextToType(current.lane, current.heldAnswers, current.hasDraft);
  if (next === "ask") return void applyLaneEvent(sessionName, { type: "settled", hasDraft: current.hasDraft });
  if (!next) return;
  // Held until it goes in, so a second click is refused meanwhile; then it
  // closes its question.
  if (!submitTalosText(sessionName, current, next.text)) return;
  const sent = heldSessions.get(sessionName);
  if (!sent) return;
  saveSession(sessionName, sent, { heldAnswers: sent.heldAnswers.filter((answer) => answer !== next) });
  applyOutputsEvent(sessionName, { type: "answered", id: next.outputId });
};

// A queued request goes in, and a finished asked-for turn ends, only once the
// session's turn is over, as its mod reports it: Claude Code's turn.complete
// comes once, at the real end, even when a person's own Stop hook keeps the
// turn going. Nothing goes into a stopped session: only the person continues
// it, at the terminal.
const stepLaneWhenSettled = (sessionName: string, token: string): void => {
  const session = heldSessions.get(sessionName);
  const isReady = session?.hookToken === token && session.isTurnOver && session.summary.state !== "stopped" && !session.sendInFlight;
  if (!isReady || !isWaitingToSettle(session)) return;
  sendNextWhenSettled(sessionName);
};

export const sendWhenSettled = (sessionName: string): void => {
  const session = heldSessions.get(sessionName);
  if (session) stepLaneWhenSettled(sessionName, session.hookToken);
};

export const askForOutput = (sessionName: string, kind: unknown): Response => {
  // A malformed request is turned down before anything is looked up, so it
  // always throws for the caller, whatever session it names.
  if (typeof kind !== "string" || !findKind(catalog(), kind)?.requestText) return new Response("expected a kind that can be asked for", { status: 400 });
  const session = heldSessions.get(sessionName);
  if (!session) return noSuchSession(sessionName);
  if (session.lane.stage !== "none") return refuse("already-asking", "It's already being asked for something");
  if (session.summary.link === "lost") return refuseLinkLost();
  applyLaneEvent(sessionName, { type: "ask", kind });
  return new Response(null, { status: 204 });
};

export const answerOutput = (sessionName: string, outputId: unknown, choice: unknown): Response => {
  if (typeof outputId !== "string" || !Number.isInteger(choice)) return new Response("expected an output id and a choice", { status: 400 });
  const session = heldSessions.get(sessionName);
  if (!session) return noSuchSession(sessionName);
  const answer = readAnswer(session.outputs, session.heldAnswers, catalog(), outputId, Number(choice), steadyNow());
  if ("code" in answer) return refuse(answer.code, answer.reason);
  saveSession(sessionName, session, { heldAnswers: [...session.heldAnswers, answer] });
  if (session.isTurnOver) stepLaneWhenSettled(sessionName, session.hookToken);
  return new Response(null, { status: 204 });
};
