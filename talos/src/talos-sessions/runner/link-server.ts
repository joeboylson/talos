// The link socket: where each session's mod checks in, sends its facts, and
// keeps its helper's stream open. Observe-only for now: the facts build a
// state of their own (fact-state.ts), logged where it differs from the one
// hooks give, and the session's summary says whether its link is up.
import { shownFactState, stepFactView, type ShownState } from "../link/fact-state";
import { steadyNow } from "../constants";
import { encodeLinkCommand, LINK_ROUTES, readCheckIn, readFacts, takeNextFacts, type CheckInAnswer, type FactsAnswer } from "../link/link-protocol";
import { parseJsonOrNull } from "../json";
import { SESSION_LIMITS } from "../limits";
import type { LinkState } from "../shapes";
import { linkSilenceMs, log } from "./inputs";
import { broadcastSessions, heldSessions, updateHeldSession, type HeldSession, type SessionLink } from "./store";

const FORBIDDEN = () => new Response(null, { status: 403 });
const BAD_REQUEST = () => new Response(null, { status: 400 });

const findSession = (isIt: (link: SessionLink) => boolean): HeldSession | undefined => [...heldSessions.values()].find((session) => isIt(session.link));

const changeLink = (session: HeldSession, change: Partial<SessionLink>, linkState?: LinkState): void => {
  const { sessionName } = session.summary;
  const current = heldSessions.get(sessionName);
  if (current?.hookToken !== session.hookToken) return;
  const summary = linkState ? { ...current.summary, link: linkState } : current.summary;
  updateHeldSession(sessionName, session.hookToken, { link: { ...current.link, ...change }, summary });
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
  const secret = crypto.randomUUID();
  changeLink(session, { isCheckedIn: true, secret, lastHeardAtMs: steadyNow() }, "linked");
  log.event(`runner: ${session.summary.sessionName} checked in (Claude Code ${checkIn.version}, mod ${checkIn.snapshot})`);
  return Response.json({ secret } satisfies CheckInAnswer);
};

// What the hooks' state comes to in the facts' terms: a turn that ended on an
// open question shows "needs you", which the facts leave to the outputs.
const hookStateOf = (session: HeldSession): ShownState =>
  session.summary.state === "needs-you" && session.isTurnOver ? "idle" : session.summary.state;

// Logged, not acted on: it shows where the facts and the hooks disagree,
// before the facts take over.
const compareStates = (sessionName: string, token: string): void => {
  const session = heldSessions.get(sessionName);
  if (session?.hookToken !== token) return;
  const fromFacts = shownFactState(session.link.factView);
  const fromHooks = hookStateOf(session);
  if (fromFacts !== fromHooks) log.event(`runner: ${sessionName}'s state differs: hooks say ${fromHooks}, its mod says ${fromFacts}`);
};

const answerFacts = async (session: HeldSession, request: Request): Promise<Response> => {
  const facts = readFacts(await readBody(request));
  if (!facts) return BAD_REQUEST();
  // Read after the body: another post (a heartbeat) may have moved the count
  // meanwhile, and a stale one would undo it.
  const current = heldSessions.get(session.summary.sessionName)?.link ?? session.link;
  const { taken, lastSeq } = takeNextFacts(current.lastSeq, facts);
  changeLink(session, { lastSeq, lastHeardAtMs: steadyNow(), factView: taken.reduce(stepFactView, current.factView) });
  taken.forEach((fact) => log.detail(`runner: ${session.summary.sessionName} fact ${fact.seq} ${fact.type} ${JSON.stringify(fact.details)}`));
  if (taken.length > 0) setTimeout(() => compareStates(session.summary.sessionName, session.hookToken), SESSION_LIMITS.stateCompareDelayMs).unref();
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
