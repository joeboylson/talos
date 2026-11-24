// The link socket: where each session's mod checks in, sends its facts, and
// keeps its helper's stream open. The facts are the session's state (see
// fact-state.ts), and the summary says whether the link is up.
import { shownFactState, stepFactView, type FactView } from "../link/fact-state";
import { steadyNow } from "../constants";
import {
  encodeLinkCommand,
  type Fact,
  LINK_ROUTES,
  readCheckIn,
  readFacts,
  readToolCallAsk,
  takeNextFacts,
  type CheckInAnswer,
  type FactsAnswer,
  type OfferedTool,
  type StopAnswer,
  type ToolCallAnswer,
} from "../link/link-protocol";
import { parseJsonOrNull } from "../json";
import { SESSION_LIMITS } from "../limits";
import type { LinkState } from "../shapes";
import { catalog, linkSilenceMs, log } from "./inputs";
import { applyLaneEvent, applyOutputsEvent, sendWhenSettled, setSessionState } from "./session-state";
import { switchTranscript } from "./transcript";
import { allowTranscriptSwitch } from "../transcript/transcript-lines";
import { giveBackWaitingMessages } from "./messages";
import { broadcast, broadcastSessions, heldSessions, runnerState, updateHeldSession, type HeldSession, type SessionLink } from "./store";

const FORBIDDEN = () => new Response(null, { status: 403 });
const BAD_REQUEST = () => new Response(null, { status: 400 });

const findSession = (isIt: (link: SessionLink) => boolean): HeldSession | undefined => [...heldSessions.values()].find((session) => isIt(session.link));

const changeLink = (session: HeldSession, change: Partial<SessionLink>, linkState?: LinkState): void => {
  const { sessionName } = session.summary;
  const current = heldSessions.get(sessionName);
  if (current?.heldId !== session.heldId) return;
  const summary = linkState ? { ...current.summary, link: linkState } : current.summary;
  updateHeldSession(sessionName, session.heldId, { link: { ...current.link, ...change }, summary });
  if (linkState) broadcastSessions();
};

// The session keeps running and its terminal still works. Once messages go
// through the mod, talos sends it nothing.
const loseLink = (session: HeldSession, why: string): void => {
  if (heldSessions.get(session.summary.sessionName)?.summary.link === "lost") return;
  log.warn(`runner: lost the link to ${session.summary.sessionName}: ${why}`);
  changeLink(session, { secret: null, commands: null }, "lost");
};

const bearerSecret = (request: Request): string | null => /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? null;

const readBody = async (request: Request): Promise<unknown> => {
  const text = await request.text();
  return text.length > SESSION_LIMITS.maxLinkBodyBytes ? null : parseJsonOrNull(text);
};

// A second check-in with a spent token comes from a mod that started over (a
// reload) and lost its secret: the link it had is gone.
const answerCheckIn = async (request: Request): Promise<Response> => {
  const checkIn = readCheckIn(await readBody(request));
  if (!checkIn) return BAD_REQUEST();
  const session = findSession((link) => link.token === checkIn.token);
  if (!session) return FORBIDDEN();
  if (session.link.isCheckedIn) {
    loseLink(session, "its mod checked in again");
    return FORBIDDEN();
  }
  // Claude Code leaves the mod off outside its engines range, so this holds
  // unless something swapped the binary under the runner.
  const { expectedClaudeVersion } = runnerState;
  if (expectedClaudeVersion && checkIn.version !== expectedClaudeVersion) {
    loseLink(session, `it runs Claude Code ${checkIn.version}, not ${expectedClaudeVersion}`);
    return FORBIDDEN();
  }
  const secret = crypto.randomUUID();
  changeLink(session, { isCheckedIn: true, secret, lastHeardAtMs: steadyNow() }, "linked");
  log.event(`runner: ${session.summary.sessionName} checked in (Claude Code ${checkIn.version}, mod ${checkIn.snapshot})`);
  return Response.json({ secret, tools: offeredTools() } satisfies CheckInAnswer);
};

// The kinds live only here, so the tools offered and the tools checked can't drift.
const offeredTools = (): OfferedTool[] => catalog().kinds.map(({ toolName, description, inputSchema }) => ({ name: toolName, description, inputSchema }));

// The session's tool call waits on this answer, and the mod gives up after 2 s,
// so nothing here waits on anything else.
const answerToolCall = async (session: HeldSession, request: Request): Promise<Response> => {
  const ask = readToolCallAsk(await readBody(request));
  if (!ask) return BAD_REQUEST();
  const { tool: toolName, input: toolInput, isSubagent, toolUseId } = ask;
  const reply = applyLaneEvent(session.summary.sessionName, { type: "tool-call", toolName, toolInput, isSubagent, toolUseId, outputId: crypto.randomUUID() });
  // A tool call always gets a result or a denial; the fallback is for the types.
  const answer: ToolCallAnswer = reply && ("result" in reply || "deny" in reply) ? reply : { deny: "talos has no answer for this call." };
  return Response.json(answer);
};

const answerStop = (session: HeldSession): Response => {
  const reply = applyLaneEvent(session.summary.sessionName, { type: "stop" });
  return Response.json((reply && "block" in reply ? { block: reply.block } : {}) satisfies StopAnswer);
};

const showPermissionAsks = (sessionName: string, token: string, view: FactView): void => {
  const session = heldSessions.get(sessionName);
  if (session?.heldId !== token) return;
  const { permissionAsks: _shown, ...summary } = session.summary;
  const permissionAsks = view.waitingPermissions.map(({ toolUseId, tool, summary: what }) => ({ id: toolUseId, tool, summary: what }));
  updateHeldSession(sessionName, token, { summary: permissionAsks.length > 0 ? { ...summary, permissionAsks } : summary });
  broadcastSessions();
};

// A turn that ended on an open question waits for the person, not idle. Only
// a change in what the facts say is applied: a fact that changes nothing (the
// prompt, just before its turn) mustn't count a turn talos just typed as over.
const showFactState = (sessionName: string, token: string, before: FactView, after: FactView): void => {
  const session = heldSessions.get(sessionName);
  if (session?.heldId !== token) return;
  const isSelfStarted = after.activity === "working" && after.turnStarter === "self";
  const isSameSelfStart = isSelfStarted === (session.summary.isSelfStarted === true);
  if (!isSameSelfStart) {
    const { isSelfStarted: _dropped, ...rest } = session.summary;
    updateHeldSession(sessionName, token, { summary: isSelfStarted ? { ...rest, isSelfStarted } : rest });
    broadcastSessions();
  }
  if (before.waitingPermissions !== after.waitingPermissions) showPermissionAsks(sessionName, token, after);
  const isSameState = shownFactState(before) === shownFactState(after) && before.isTurnOver === after.isTurnOver;
  if (isSameState) return;
  const shown = shownFactState(after);
  const hasOpenOutput = session.summary.openOutputs.length > 0;
  // Its turn over, what waited goes in (messages sent while it started first).
  // Stopped, it goes back to the page: only the person continues it, there.
  setSessionState(sessionName, shown === "idle" && hasOpenOutput ? "needs-you" : shown, after.isTurnOver);
  if (shown === "stopped") giveBackWaitingMessages(sessionName);
};

// Once Claude Code has taken talos's send, the next may go when the turn is
// over. One it dropped (after Esc, until the person enters something) starts
// no turn: the session is as its facts say, and what waits can go in once
// it's settled.
const handleSubmitsDone = (sessionName: string, token: string, taken: readonly Fact[]): void => {
  const done = taken.filter((fact) => fact.type === "submit-done");
  const session = heldSessions.get(sessionName);
  if (done.length === 0 || session?.heldId !== token) return;
  const isInFlightDone = done.some((fact) => fact.details.sendId === session.sendInFlight);
  const dropped = done.filter((fact) => typeof fact.details.drop === "string");
  dropped.forEach((fact) => broadcast({ type: "notice", sessionName, message: `A message didn't go in: ${String(fact.details.drop)}` }));
  const isTurnOver = dropped.length > 0 ? session.link.factView.isTurnOver : session.isTurnOver;
  updateHeldSession(sessionName, token, { isTurnOver, ...(isInFlightDone && { sendInFlight: null }) });
  sendWhenSettled(sessionName);
};

const noteInterruptedTurn = (sessionName: string, token: string, taken: readonly Fact[]): void => {
  const ended = taken.find((fact) => fact.type === "turn-complete" && fact.details.agentId === undefined);
  const session = heldSessions.get(sessionName);
  if (!ended || session?.heldId !== token || !session.isInterrupting) return;
  updateHeldSession(sessionName, token, { isInterrupting: false, wasInterrupted: ended.details.reason === "aborted" });
};

// Claude Code can move to another conversation file (after /clear or /resume),
// and a question closes only at the end of the person's own turn. One stopped
// before it finished doesn't count: the question is still worth answering.
const followFacts = (sessionName: string, token: string, taken: readonly Fact[]): void =>
  taken.forEach((fact) => {
    const session = heldSessions.get(sessionName);
    if (session?.heldId !== token) return;
    const isMainLoop = fact.details.agentId === undefined;
    if (fact.type === "turn-start" && isMainLoop) applyOutputsEvent(sessionName, { type: "turn-started", isPersonTurn: fact.details.startedBy === "person" });
    if (fact.type === "turn-complete" && isMainLoop && fact.details.reason !== "aborted") applyOutputsEvent(sessionName, { type: "turn-ended" });
    const path = fact.type === "transcript" ? fact.details.path : null;
    const currentPath = session.transcripts.at(-1)?.path ?? null;
    if (typeof path === "string" && path !== currentPath && allowTranscriptSwitch(path, currentPath)) {
      heldSessions.set(sessionName, { ...session, transcripts: switchTranscript(session.transcripts, path) });
    }
  });

const answerFacts = async (session: HeldSession, request: Request): Promise<Response> => {
  const facts = readFacts(await readBody(request));
  if (!facts) return BAD_REQUEST();
  // Read after the body: another post (a heartbeat) may have moved the count
  // meanwhile, and a stale one would undo it.
  const current = heldSessions.get(session.summary.sessionName)?.link ?? session.link;
  const { taken, lastSeq } = takeNextFacts(current.lastSeq, facts);
  const factView = taken.reduce(stepFactView, current.factView);
  changeLink(session, { lastSeq, lastHeardAtMs: steadyNow(), factView });
  taken.forEach((fact) => log.detail(`runner: ${session.summary.sessionName} fact ${fact.seq} ${fact.type} ${JSON.stringify(fact.details)}`));
  followFacts(session.summary.sessionName, session.heldId, taken);
  noteInterruptedTurn(session.summary.sessionName, session.heldId, taken);
  showFactState(session.summary.sessionName, session.heldId, current.factView, factView);
  handleSubmitsDone(session.summary.sessionName, session.heldId, taken);
  return Response.json({ acked: lastSeq } satisfies FactsAnswer);
};

const openCommands = (session: HeldSession): Response => {
  const stream = new ReadableStream<string>({
    start: (controller) => changeLink(session, { commands: controller }),
    cancel: () => loseLink(session, "its helper is gone"),
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
};

const answerLinkRequest = async (request: Request): Promise<Response> => {
  const { pathname } = new URL(request.url);
  if (request.method === "POST" && pathname === LINK_ROUTES.checkIn) return answerCheckIn(request);
  const secret = bearerSecret(request);
  const session = secret ? findSession((link) => link.secret === secret) : undefined;
  if (!session) return FORBIDDEN();
  if (request.method === "POST" && pathname === LINK_ROUTES.facts) return answerFacts(session, request);
  if (request.method === "GET" && pathname === LINK_ROUTES.commands) return openCommands(session);
  if (request.method === "POST" && pathname === LINK_ROUTES.toolCall) return answerToolCall(session, request);
  if (request.method === "POST" && pathname === LINK_ROUTES.stop) return answerStop(session);
  return new Response(null, { status: 404 });
};

export const linkServeOptions = (linkSocket: string) => ({
  unix: linkSocket,
  idleTimeout: SESSION_LIMITS.linkIdleTimeoutSeconds,
  maxRequestBodySize: SESSION_LIMITS.maxLinkBodyBytes,
  fetch: answerLinkRequest,
});

// A write to a helper that's gone throws: that's the link lost too. So is a
// mod gone quiet: a hook stuck in a loop leaves it dead while its helper
// stays up.
export const sendHeartbeats = (): void =>
  [...heldSessions.values()].forEach((session) => {
    const { commands, secret, lastHeardAtMs } = session.link;
    const isQuiet = secret !== null && steadyNow() - lastHeardAtMs > linkSilenceMs();
    if (isQuiet) return loseLink(session, "its mod went quiet");
    if (!commands) return;
    try {
      commands.enqueue(encodeLinkCommand({ type: "heartbeat" }));
    } catch {
      loseLink(session, "its helper stopped reading");
    }
  });
