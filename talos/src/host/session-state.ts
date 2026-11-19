// A session's state and its status lane: every change to either goes through here.
import type { SessionState, SessionSummary } from "talos-shared";
import { READY_CHECK_MS, READY_QUIET_MS } from "../constants";
import { STATUS_REQUEST_PROMPT, stepStatusLane, type StatusLaneEvent, type StatusLaneStep } from "../status-lane";
import { ENTER_KEY, buildPastedText } from "../terminal";
import { log } from "./log";
import { broadcastSessions, heldSessions, updateHeldSession } from "./store";

const applyDecisionChange = (summary: SessionSummary, change: StatusLaneStep["decisionChange"]): SessionSummary => {
  if (change === null) return summary;
  if (change !== "clear") return { ...summary, decision: change };
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
  return step.hookReply;
};

// A session can be asked for a status at an idle input box: idle, or done with
// its turn and waiting on the person's answer to a decision (which stays open).
const canBeAsked = (summary: SessionSummary): boolean =>
  summary.state === "idle" || (summary.state === "needs-you" && summary.decision !== undefined);

export const setSessionState = (sessionName: string, state: SessionState) => {
  const session = heldSessions.get(sessionName);
  if (!session || session.summary.state === state) return;
  heldSessions.set(sessionName, { ...session, summary: { ...session.summary, state } });
  log.detail(`host: ${sessionName} is ${state}`);
  broadcastSessions();
  if (canBeAsked({ ...session.summary, state })) void startQueuedAskWhenSettled(sessionName, session.hookToken);
};

// A queued status request is typed only once the session is idle and its screen
// has been still for a moment. talos counts a session idle on its own Stop
// decision, but Claude Code also runs the person's own Stop hooks, and one can
// block the Stop and keep the turn going. A request typed then is folded into
// that running turn, which would then lose its tools. Claude Code animates a
// spinner while Stop hooks and the turn run, so the screen doesn't settle.
// shortcut: with reduced motion there's no spinner, so a slow, silent Stop hook
// can still let the request fold in; and a status line that repaints every
// second keeps the screen from ever settling, so the ask ends at its timeout.
// Upgrade when Claude Code gives a real end-of-turn signal.
const startQueuedAskWhenSettled = async (sessionName: string, token: string): Promise<void> => {
  const waitingSession = heldSessions.get(sessionName);
  if (waitingSession?.hookToken !== token || waitingSession.isWaitingToAsk) return;
  updateHeldSession(sessionName, token, { isWaitingToAsk: true });
  try {
    while (true) {
      const session = heldSessions.get(sessionName);
      const isStillWaiting = session?.hookToken === token && session.statusLane.kind === "queued" && canBeAsked(session.summary);
      if (!isStillWaiting) return;
      const quietForMs = Date.now() - session.lastOutputAtMs;
      if (quietForMs >= READY_QUIET_MS) return void applyStatusLaneEvent(sessionName, { type: "idle", hasDraft: session.hasDraft });
      await Bun.sleep(READY_CHECK_MS);
    }
  } catch (error) {
    // Logged, not thrown: Bun quits on an unhandled rejection, which would end
    // every session the host holds.
    log.warn(`host: couldn't start ${sessionName}'s status ask: ${error}`);
  } finally {
    updateHeldSession(sessionName, token, { isWaitingToAsk: false });
  }
};

export const askForStatus = (sessionName: string): Response => {
  const session = heldSessions.get(sessionName);
  if (!session) return new Response(`no session ${sessionName}`, { status: 404 });
  applyStatusLaneEvent(sessionName, { type: "ask" });
  if (canBeAsked(session.summary)) void startQueuedAskWhenSettled(sessionName, session.hookToken);
  return new Response(null, { status: 204 });
};
