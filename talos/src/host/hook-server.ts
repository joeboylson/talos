// The hooks socket: the only routes a session can reach, its own Claude Code hooks.
import type { BunRequest } from "bun";
import { HOOK_MAX_BODY_BYTES, HOOK_TOKEN_HEADER, HOST_HOOKS_SOCKET, READY_LONGEST_WAIT_MS } from "../constants";
import { HOST_ROUTES, sessionNameOf } from "../host-protocol";
import { hookTokenAuthorized, nextSessionState } from "../session-hooks";
import { readStatusLaneEvent } from "../status-lane";
import { allowTranscriptSwitch } from "../transcript-lines";
import { becomeReadyWhenQuiet } from "./lifecycle";
import { log } from "./log";
import { applyStatusLaneEvent, setSessionState } from "./session-state";
import { heldSessions, updateHeldSession } from "./store";

const handleHook = (sessionName: string, hookDetailsText: string): string => {
  const session = heldSessions.get(sessionName);
  if (!session) return "";
  const hookDetails: unknown = JSON.parse(hookDetailsText || "{}");
  const hookEvent = String(Reflect.get(hookDetails as object, "hook_event_name") ?? "");

  const statusLaneEvent = readStatusLaneEvent(hookDetails);
  const decision = statusLaneEvent ? applyStatusLaneEvent(sessionName, statusLaneEvent) : "";

  // Only one ready-loop per session instance, so a forged flood of SessionStart
  // events can't pile up uncancelled loops and exhaust the host's memory.
  if (hookEvent === "SessionStart" && !session.isBecomingReady) {
    updateHeldSession(sessionName, session.hookToken, { isBecomingReady: true });
    void becomeReadyWhenQuiet(sessionName, session.hookToken, Date.now() + READY_LONGEST_WAIT_MS)
      .catch((error: unknown) => log.warn(`host: couldn't finish starting ${sessionName}: ${error}`))
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
  // A Stop the lane blocked keeps the turn going, so the session isn't idle.
  const blockedStop = hookEvent === "Stop" && decision !== "";
  const nextState = nextSessionState(hookEvent, hookDetails);
  if (nextState && !blockedStop) setSessionState(sessionName, nextState);
  return decision;
};

export const hookServeOptions = {
  unix: HOST_HOOKS_SOCKET,
  // Bounded so a session can't POST a huge body that blocks the host's one thread
  // in JSON.parse long enough for other sessions' hooks to time out and fail open.
  maxRequestBodySize: HOOK_MAX_BODY_BYTES,
  routes: {
    [HOST_ROUTES.health]: new Response("ok"),
    [HOST_ROUTES.hooks]: {
      POST: async (request: BunRequest) => {
        const sessionName = sessionNameOf(request);
        // The hooks socket is shared by every session, so bind the POST to its
        // session with a per-session token; a request for a session whose token
        // it doesn't have is ignored, so one session can't drive another's hooks.
        if (!hookTokenAuthorized(request.headers.get(HOOK_TOKEN_HEADER), heldSessions.get(sessionName)?.hookToken)) {
          log.warn(`host: ignored a hook for "${sessionName}" with a bad token`);
          return new Response("");
        }
        const hookDetailsText = await request.text();
        try {
          // The hook script prints this to Claude Code; empty means no decision.
          return new Response(handleHook(sessionName, hookDetailsText));
        } catch (error) {
          log.warn(`host: couldn't handle a hook: ${error}`);
          return new Response("");
        }
      },
    },
  },
  fetch: () => new Response("Not found", { status: 404 }),
};
