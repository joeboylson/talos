// The link socket: where each session's mod checks in, sends its facts, and
// keeps its helper's stream open. The facts are the session's state (see
// fact-state.ts), and the summary says whether the link is up.
import { steadyNow } from "../constants";
import {
  encodeLinkCommand,
  LINK_ROUTES,
  readCheckIn,
  readFacts,
  readToolCallAsk,
  readToolCheckAsk,
  takeNextFacts,
  type CheckInAnswer,
  type FactsAnswer,
  type OfferedTool,
  type StopAnswer,
  type ToolCallAnswer,
  type ToolCheckAnswer,
} from "../link/link-protocol";
import { parseJsonOrNull } from "../json";
import { SESSION_LIMITS } from "../limits";
import type { LinkState } from "../shapes";
import { catalog, linkSilenceMs, log } from "./inputs";
import { applyLaneEvent } from "./session-state";
import { onlyToolOf } from "../lanes/lane";
import { broadcastSessions, heldSessions, runnerState, updateHeldSession, type HeldSession, type SessionLink } from "./store";

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

// The session keeps running and takes messages, but talos's tools and asks
// need the mod, so asks are refused.
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

// The lane changes before a message goes in, so this answer is always the
// rule for the turn the call belongs to.
const answerToolCheck = async (session: HeldSession, request: Request): Promise<Response> => {
  const ask = readToolCheckAsk(await readBody(request));
  if (!ask) return BAD_REQUEST();
  const current = heldSessions.get(session.summary.sessionName);
  const onlyTool = current ? onlyToolOf(current.lane, catalog()) : null;
  const isDenied = onlyTool !== null && !ask.isSubagent && ask.tool !== onlyTool;
  return Response.json((isDenied ? { deny: `Only ${onlyTool} is allowed this turn.` } : {}) satisfies ToolCheckAnswer);
};

const answerStop = (session: HeldSession): Response => {
  const reply = applyLaneEvent(session.summary.sessionName, { type: "stop" });
  return Response.json((reply && "block" in reply ? { block: reply.block } : {}) satisfies StopAnswer);
};

const answerFacts = async (session: HeldSession, request: Request): Promise<Response> => {
  const facts = readFacts(await readBody(request));
  if (!facts) return BAD_REQUEST();
  // Read after the body: another post (a heartbeat) may have moved the count
  // meanwhile, and a stale one would undo it.
  const current = heldSessions.get(session.summary.sessionName)?.link ?? session.link;
  const { taken, lastSeq } = takeNextFacts(current.lastSeq, facts);
  changeLink(session, { lastSeq, lastHeardAtMs: steadyNow() });
  taken.forEach((fact) => log.detail(`runner: ${session.summary.sessionName} fact ${fact.seq} ${fact.type} ${JSON.stringify(fact.details)}`));
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
  if (request.method === "POST" && pathname === LINK_ROUTES.toolCheck) return answerToolCheck(session, request);
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
