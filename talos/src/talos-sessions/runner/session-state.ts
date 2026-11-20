// A session's state and its status lane: every change to either goes through here.
import type { SessionState, SessionSummary } from "../shapes";
import { READY_CHECK_MS, READY_QUIET_MS } from "../constants";
import { STATUS_REQUEST_PROMPT, stepStatusLane, type StatusLaneEvent, type StatusLaneStep } from "../lanes/status-lane";
import { ENTER_KEY, buildPastedText } from "../terminal";
import { log } from "./inputs";
import { broadcastSessions, heldSessions, updateHeldSession } from "./store";

const applyDecisionChange = (summary: SessionSummary, change: StatusLaneStep["decisionChange"]): SessionSummary => {
  if (change === null) return summary;
  // The first open question stands until it's answered, so its choices can't
  // change under the person's click.
  if (change !== "clear") return summary.decision ? summary : { ...summary, decision: change };
  if (!summary.decision) return summary;
  const { decision: _answered, ...withoutDecision } = summary;
  return withoutDecision;
};

// Every status lane change goes through here: step the lane, then apply what
// the step says (new status, typed request) and return the hook's reply.
export const applyStatusLaneEvent = (sessionName: string, event: StatusLaneEvent): string => {
  const session = heldSessions.get(sessionName);
  if (!session) return "";
  const step = stepStatusLane(session.statusLane, event, Date.now());
  const withStatus = step.statusChange ? { ...session.summary, status: step.statusChange } : session.summary;
  const summary = applyDecisionChange(withStatus, step.decisionChange);
  heldSessions.set(sessionName, { ...session, statusLane: step.lane, summary });
  if (summary !== session.summary) broadcastSessions();
  if (step.shouldTypeRequest) {
    session.terminal.write(buildPastedText(STATUS_REQUEST_PROMPT));
    session.terminal.write(ENTER_KEY);
  }
  // A lane left waiting to settle while the turn is already over gets its wait
  // now, not only when the session's state next changes.
  const isWaitingToSettle = step.lane.kind === "queued" || step.lane.kind === "reported";
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

// A queued status request is typed, and a finished status turn ends, only once
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
      const isWaitingLane = session?.statusLane.kind === "queued" || session?.statusLane.kind === "reported";
      const isStillWaiting = session?.hookToken === token && isWaitingLane && session.isTurnOver;
      if (!isStillWaiting) return;
      const quietForMs = Date.now() - session.lastOutputAtMs;
      if (quietForMs >= READY_QUIET_MS) return void applyStatusLaneEvent(sessionName, { type: "settled", hasDraft: session.hasDraft });
      await Bun.sleep(READY_CHECK_MS);
    }
  } catch (error) {
    // Logged, not thrown: Bun quits on an unhandled rejection, which would end
    // every session the session runner holds.
    log.warn(`runner: couldn't start ${sessionName}'s status ask: ${error}`);
  } finally {
    updateHeldSession(sessionName, token, { isWaitingToAsk: false });
  }
};

export const askForStatus = (sessionName: string): Response => {
  const session = heldSessions.get(sessionName);
  if (!session) return new Response(`no session ${sessionName}`, { status: 404 });
  applyStatusLaneEvent(sessionName, { type: "ask" });
  return new Response(null, { status: 204 });
};
