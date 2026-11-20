// A session's state and its lane: every change to either goes through here.
import type { SessionState, SessionSummary } from "../shapes";
import { READY_CHECK_MS, READY_QUIET_MS } from "../constants";
import { findKind } from "../kinds";
import { stepLane, type LaneEvent, type LaneStep } from "../lanes/lane";
import { ENTER_KEY, buildPastedText } from "../terminal";
import { catalog, log } from "./inputs";
import { broadcastSessions, heldSessions, updateHeldSession } from "./store";

// What a step changes in the summary: an ask's state, its latest answer, and the
// open outputs. The first open output of a kind stands until it's answered, so
// its choices can't change under the person's click.
const applyStep = (summary: SessionSummary, step: LaneStep): SessionSummary => {
  const { recorded, askChange } = step;
  const asks = askChange
    ? {
        ...summary.asks,
        [askChange.kind]: {
          ...summary.asks[askChange.kind],
          state: askChange.state,
          atMs: askChange.atMs,
          ...(askChange.state === "answered" && recorded && { latest: recorded.fields }),
        },
      }
    : summary.asks;
  const keptOutputs = step.closesOpenOutputs ? [] : summary.openOutputs;
  const waits = recorded !== null && askChange === null && findKind(catalog(), recorded.kind)?.waits === true;
  const isNewOpenOutput = waits && !keptOutputs.some((output) => output.kind === recorded.kind);
  const openOutputs = isNewOpenOutput ? [...keptOutputs, recorded] : keptOutputs;
  const isUnchanged = asks === summary.asks && openOutputs === summary.openOutputs;
  return isUnchanged ? summary : { ...summary, asks, openOutputs };
};

// Every lane change goes through here: step the lane, then apply what the step
// says (an answer, a typed request) and return the hook's reply.
export const applyLaneEvent = (sessionName: string, event: LaneEvent): string => {
  const session = heldSessions.get(sessionName);
  if (!session) return "";
  const step = stepLane(session.lane, event, Date.now(), catalog());
  const summary = applyStep(session.summary, step);
  heldSessions.set(sessionName, { ...session, lane: step.lane, summary });
  if (summary !== session.summary) broadcastSessions();
  if (step.requestToType) {
    session.terminal.write(buildPastedText(step.requestToType));
    session.terminal.write(ENTER_KEY);
  }
  // A lane left waiting to settle while the turn is already over gets its wait
  // now, not only when the session's state next changes.
  const isWaitingToSettle = step.lane.stage === "queued" || step.lane.stage === "answered";
  if (isWaitingToSettle && session.isTurnOver) void stepLaneWhenSettled(sessionName, session.hookToken);
  return step.hookReply;
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
      const isWaitingLane = session?.lane.stage === "queued" || session?.lane.stage === "answered";
      const isStillWaiting = session?.hookToken === token && isWaitingLane && session.isTurnOver;
      if (!isStillWaiting) return;
      const quietForMs = Date.now() - session.lastOutputAtMs;
      if (quietForMs >= READY_QUIET_MS) return void applyLaneEvent(sessionName, { type: "settled", hasDraft: session.hasDraft });
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
  if (!heldSessions.has(sessionName)) return new Response(`no session ${sessionName}`, { status: 404 });
  if (typeof kind !== "string" || !findKind(catalog(), kind)?.requestText) return new Response("expected a kind talos can ask for", { status: 400 });
  applyLaneEvent(sessionName, { type: "ask", kind });
  return new Response(null, { status: 204 });
};
