// A session's state and its lane: every change to either goes through here.
import { mergeSessionEntries, type SessionEntry, type SessionState, type SessionSummary } from "../shapes";
import { READY_CHECK_MS, READY_QUIET_MS } from "../constants";
import { findKind } from "../kinds";
import { stepLane, type LaneEvent, type LaneStep } from "../lanes/lane";
import { placeOutputs, stepOutputs, type CallPlace, type Outputs, type OutputsEvent, type PendingOutput } from "../lanes/outputs";
import { SESSION_LIMITS } from "../limits";
import { keptHeld, nextToType, readAnswer, type HeldAnswer } from "../lanes/held";
import { ENTER_KEY, ESC_KEY, ESC_PAUSE_MS, buildPastedText } from "../terminal";
import { catalog, log } from "./inputs";
import { noSuchSession, refuse } from "./refuse";
import { broadcast, broadcastSessions, heldSessions, typeInTurn, updateHeldSession, type HeldSession } from "./store";

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

// What talos itself types (a request, an answer) only goes in once the turn is
// over, and Esc first, so even a forged "turn over" can at worst refuse a
// permission prompt, never approve one. Typing starts a turn, so nothing else
// talos holds goes in until that turn is over too.
// shortcut: if what's typed never starts a turn, the session shows working until
// its next hook; upgrade when Claude Code gives a real end-of-turn signal.
// It waits its turn with whatever else types into the session (typeInTurn), and
// gives way (false) if the person has started typing by then.
const typeTalosText = (sessionName: string, session: HeldSession, text: string): Promise<boolean> =>
  typeInTurn(sessionName, async () => {
    const current = heldSessions.get(sessionName);
    if (current?.hookToken !== session.hookToken || current.hasDraft) return false;
    setSessionState(sessionName, "working", false);
    updateHeldSession(sessionName, session.hookToken, { isTalosTypedNext: true });
    session.terminal.write(ESC_KEY);
    await Bun.sleep(ESC_PAUSE_MS);
    session.terminal.write(buildPastedText(text));
    session.terminal.write(ENTER_KEY);
    return true;
  });

const notify = (sessionName: string, dropped: readonly HeldAnswer[]): void => {
  if (dropped.length > 0) broadcast({ type: "notice", sessionName, message: "An answer was dropped: its question closed, or the session never settled" });
};

// Every lane change goes through here: step the lane, then apply what the step
// says (an output sent, an ask's change, a typed request) and return the hook's reply.
export const applyLaneEvent = (sessionName: string, event: LaneEvent): string => {
  const session = heldSessions.get(sessionName);
  if (!session) return "";
  const nowMs = Date.now();
  const step = stepLane(session.lane, event, nowMs, catalog());
  const outputs = step.sent ? stepOutputs(session.outputs, { type: "sent", output: step.sent }).outputs : session.outputs;
  const heldAnswers = event.type === "tick" ? keptHeld(session.heldAnswers, [], nowMs) : session.heldAnswers;
  const isPersonTurn = event.type === "person-typed" && event.isTurnChanging;
  const isTalosTypedNext = session.isTalosTypedNext && !isPersonTurn;
  saveSession(sessionName, session, { lane: step.lane, outputs, heldAnswers, isTalosTypedNext, summary: withAsk(session.summary, step.askChange) });
  notify(sessionName, session.heldAnswers.filter((answer) => !heldAnswers.includes(answer)));
  // A request that gave way to the person's typing ends its ask, as their typing would.
  if (step.requestToType) {
    void typeTalosText(sessionName, session, step.requestToType).then(
      (isTyped) => isTyped || void applyLaneEvent(sessionName, { type: "person-typed", isTurnChanging: true }),
    );
  }
  // A lane or answer left waiting to settle while the turn is already over gets
  // its wait now, not only when the session's state next changes.
  if (isWaitingToSettle(heldSessions.get(sessionName)) && session.isTurnOver) void stepLaneWhenSettled(sessionName, session.hookToken);
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
  const heldAnswers = keptHeld(session.heldAnswers, step.closedIds, Date.now());
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
  heldSessions.set(sessionName, { ...session, isTurnOver, summary: { ...session.summary, state } });
  log.detail(`runner: ${sessionName} is ${state}`);
  broadcastSessions();
  if (isTurnOver) void stepLaneWhenSettled(sessionName, session.hookToken);
};

const isWaitingToSettle = (session: HeldSession | undefined): boolean =>
  session !== undefined && (session.lane.stage === "queued" || session.lane.stage === "answered" || session.heldAnswers.length > 0);

// Once the screen has settled: a finished asked-for turn ends, then the oldest
// of a queued ask and the held answers goes in. One per settle: what's typed
// starts a turn, and the next goes in once that one is over.
const typeNextWhenSettled = async (sessionName: string): Promise<void> => {
  const session = heldSessions.get(sessionName);
  if (!session) return;
  if (session.lane.stage === "answered") applyLaneEvent(sessionName, { type: "settled", hasDraft: session.hasDraft });
  const current = heldSessions.get(sessionName);
  if (!current) return;
  const next = nextToType(current.lane, current.heldAnswers, current.hasDraft);
  if (next === "ask") return void applyLaneEvent(sessionName, { type: "settled", hasDraft: current.hasDraft });
  if (!next) return;
  // Held until it's typed, so a second click is refused meanwhile; then it
  // closes its question. One that gave way to the person's typing stays held.
  if (!(await typeTalosText(sessionName, current, next.text))) return;
  const typed = heldSessions.get(sessionName);
  if (!typed) return;
  saveSession(sessionName, typed, { heldAnswers: typed.heldAnswers.filter((answer) => answer !== next) });
  applyOutputsEvent(sessionName, { type: "answered", id: next.outputId });
};

// A queued request is typed, and a finished asked-for turn ends, only once
// the session's turn is over and its screen has been still for a moment. talos counts a session idle on its own Stop
// decision, but Claude Code also runs the person's own Stop hooks, and one can
// block the Stop and keep the turn going. A request typed then is folded into
// that running turn, which would then lose its tools. Claude Code animates a
// spinner while Stop hooks and the turn run, so the screen doesn't settle.
// shortcut: with reduced motion there's no spinner, so a slow, silent Stop hook
// can still let the request fold in; and a status line that repaints every
// second keeps the screen from ever settling, so the ask ends at its timeout.
// Upgrade when Claude Code gives a real end-of-turn signal.
const stepLaneWhenSettled = async (sessionName: string, token: string): Promise<void> => {
  const waitingSession = heldSessions.get(sessionName);
  if (waitingSession?.hookToken !== token || waitingSession.isWaitingToAsk) return;
  updateHeldSession(sessionName, token, { isWaitingToAsk: true });
  try {
    while (true) {
      const session = heldSessions.get(sessionName);
      const isStillWaiting = session?.hookToken === token && isWaitingToSettle(session) && session.isTurnOver;
      if (!isStillWaiting) return;
      const quietForMs = Date.now() - session.lastOutputAtMs;
      // Awaited, so no second settle loop starts while this one types.
      if (quietForMs >= READY_QUIET_MS) return await typeNextWhenSettled(sessionName);
      await Bun.sleep(READY_CHECK_MS);
    }
  } catch (error) {
    // Logged, not thrown: Bun quits on an unhandled rejection, which would end
    // every session the session runner holds.
    log.warn(`runner: couldn't start ${sessionName}'s ask: ${error}`);
  } finally {
    updateHeldSession(sessionName, token, { isWaitingToAsk: false });
  }
};

export const askForOutput = (sessionName: string, kind: unknown): Response => {
  // A malformed request is turned down before anything is looked up, so it
  // always throws for the caller, whatever session it names.
  if (typeof kind !== "string" || !findKind(catalog(), kind)?.requestText) return new Response("expected a kind that can be asked for", { status: 400 });
  const session = heldSessions.get(sessionName);
  if (!session) return noSuchSession(sessionName);
  if (session.lane.stage !== "none") return refuse("already-asking", "It's already being asked for something");
  applyLaneEvent(sessionName, { type: "ask", kind });
  return new Response(null, { status: 204 });
};

export const answerOutput = (sessionName: string, outputId: unknown, choice: unknown): Response => {
  if (typeof outputId !== "string" || !Number.isInteger(choice)) return new Response("expected an output id and a choice", { status: 400 });
  const session = heldSessions.get(sessionName);
  if (!session) return noSuchSession(sessionName);
  const answer = readAnswer(session.outputs, session.heldAnswers, catalog(), outputId, Number(choice), Date.now());
  if ("code" in answer) return refuse(answer.code, answer.reason);
  saveSession(sessionName, session, { heldAnswers: [...session.heldAnswers, answer] });
  if (session.isTurnOver) void stepLaneWhenSettled(sessionName, session.hookToken);
  return new Response(null, { status: 204 });
};
