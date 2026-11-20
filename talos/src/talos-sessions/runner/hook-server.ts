// The hooks socket: the only routes a session can reach, its own Claude Code hooks.
import type { Socket } from "bun";
import { RUNNER_HOOKS_SOCKET, NEWLINE_BYTE } from "../constants";
import { encodeHookLine, readHookRequest, type HookAnswer } from "../client/runner-protocol";
import { hookTokenAuthorized, nextSessionState } from "../claude/session-hooks";
import { readStatusLaneEvent } from "../lanes/status-lane";
import { allowTranscriptSwitch } from "../transcript/transcript-lines";
import { becomeReadyWhenQuiet } from "./lifecycle";
import { log } from "./log";
import { applyStatusLaneEvent, setSessionState } from "./session-state";
import { heldSessions, updateHeldSession } from "./store";
import { SESSION_LIMITS } from "../limits";

const handleHook = (sessionName: string, token: string, hookDetailsText: string): string => {
  const session = heldSessions.get(sessionName);
  // The token was checked before the body was read; the session may have been
  // replaced under its name since, and a request from the old one must not act.
  if (session?.hookToken !== token) return "";
  const hookDetails: unknown = JSON.parse(hookDetailsText || "{}");
  const hookEvent = String(Reflect.get(hookDetails as object, "hook_event_name") ?? "");

  const statusLaneEvent = readStatusLaneEvent(hookDetails);
  const decision = statusLaneEvent ? applyStatusLaneEvent(sessionName, statusLaneEvent) : "";

  // Only one ready-loop per session instance, so a forged flood of SessionStart
  // events can't pile up uncancelled loops and exhaust the session runner's memory.
  if (hookEvent === "SessionStart" && !session.isBecomingReady) {
    updateHeldSession(sessionName, session.hookToken, { isBecomingReady: true });
    void becomeReadyWhenQuiet(sessionName, session.hookToken, Date.now() + SESSION_LIMITS.readyLongestWaitMs)
      .catch((error: unknown) => log.warn(`runner: couldn't finish starting ${sessionName}: ${error}`))
      .finally(() => updateHeldSession(sessionName, session.hookToken, { isBecomingReady: false }));
  }

  // Claude Code can start a new conversation file (like after /clear), so
  // a new path starts over from its beginning.
  const transcriptPath = Reflect.get(hookDetails as object, "transcript_path");
  const current = heldSessions.get(sessionName);
  const isNewTranscript =
    typeof transcriptPath === "string" &&
    current !== undefined &&
    transcriptPath !== current.transcript?.path &&
    allowTranscriptSwitch(transcriptPath, current.transcript?.path ?? null);
  if (isNewTranscript && current) {
    heldSessions.set(sessionName, { ...current, transcript: { path: transcriptPath, readByteCount: 0, runningTools: new Map() } });
  }
  // A Stop the lane blocked keeps the turn going, so the session isn't idle. A
  // turn that ends on an open decision is waiting for the person, not idle.
  const blockedStop = hookEvent === "Stop" && decision !== "";
  const nextState = nextSessionState(hookEvent, hookDetails);
  const hasOpenDecision = heldSessions.get(sessionName)?.summary.decision !== undefined;
  const isTurnOver = nextState === "idle";
  const shownState = isTurnOver && hasOpenDecision ? "needs-you" : nextState;
  if (shownState && !blockedStop) setSessionState(sessionName, shownState, isTurnOver);
  return decision;
};

// The answer to one hook request. The token check and the hook's handling run
// in one step, so a session replaced under the same name can't be acted on.
const answerHookRequest = (line: string): HookAnswer => {
  const request = readHookRequest(line);
  if (!request) return { kind: "reply", reply: "" };
  const { sessionName, token, details } = request;
  if (!hookTokenAuthorized(token, heldSessions.get(sessionName)?.hookToken)) {
    log.warn(`runner: ignored a hook for "${sessionName}" with a bad token`);
    return { kind: "reply", reply: "" };
  }
  try {
    // The hook script prints this to Claude Code; empty means no decision.
    return { kind: "reply", reply: handleHook(sessionName, token, details) };
  } catch (error) {
    log.warn(`runner: couldn't handle a hook: ${error}`);
    return { kind: "reply", reply: "" };
  }
};

type HookConnection = { chunks: Buffer[]; byteCount: number; deadline: ReturnType<typeof setTimeout> };
type HookSocket = Socket<HookConnection>;

// Oldest first, so a new connection past the cap closes the oldest: a real
// hook connects and sends at once, while a flood's idle connections linger.
const openHookSockets = new Set<HookSocket>();

const closeHookSocket = (socket: HookSocket) => {
  clearTimeout(socket.data.deadline);
  openHookSockets.delete(socket);
  socket.end();
};

const answerAndClose = (socket: HookSocket, answer: HookAnswer) => {
  socket.write(encodeHookLine(answer));
  closeHookSocket(socket);
};

// The only route a session can reach: its own Claude Code hooks. A request is
// one line; it's bounded so a session can't send a huge body that blocks the
// session runner's one thread in JSON.parse long enough for other sessions' hooks to time
// out and fail open.
export const startHookServer = () =>
  Bun.listen<HookConnection>({
    unix: RUNNER_HOOKS_SOCKET,
    socket: {
      open: (socket) => {
        const oldestSocket = openHookSockets.values().next().value;
        if (openHookSockets.size >= SESSION_LIMITS.maxHookConnections && oldestSocket) closeHookSocket(oldestSocket);
        socket.data = { chunks: [], byteCount: 0, deadline: setTimeout(() => closeHookSocket(socket), SESSION_LIMITS.hookTimeoutMs) };
        openHookSockets.add(socket);
      },
      data: (socket, chunk) => {
        if (!openHookSockets.has(socket)) return;
        socket.data.chunks.push(chunk);
        socket.data.byteCount += chunk.length;
        if (socket.data.byteCount > SESSION_LIMITS.maxHookBodyBytes) return answerAndClose(socket, { kind: "too-big" });
        if (!chunk.includes(NEWLINE_BYTE)) return;
        const received = Buffer.concat(socket.data.chunks).toString();
        answerAndClose(socket, answerHookRequest(received.slice(0, received.indexOf("\n"))));
      },
      close: (socket) => {
        clearTimeout(socket.data?.deadline);
        openHookSockets.delete(socket);
      },
      error: (socket, error) => {
        log.warn(`runner: a hook connection failed: ${error}`);
        closeHookSocket(socket);
      },
    },
  });
