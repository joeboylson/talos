// Turns what talos-sessions hands out into talos-shared's shapes before it goes
// to the server and the page. The module knows nothing of talos-shared, so this
// is the one place the two meet.
import { readSessionDecision, readSessionStatus, type SessionEntry, type SessionSummary } from "talos-shared";
import type { RunnerEvent, SessionEntry as RunnerEntry, SessionSummary as RunnerSummary } from "./talos-sessions";

export type SharedRunnerEvent =
  | { type: "sessions"; sessions: SessionSummary[] }
  | { type: "session-entries"; sessionName: string; entries: SessionEntry[] };

// status and decision are talos's own kinds, so the module passes them through
// unchecked and they're checked here. A bad one is left out.
const toSharedSummary = ({ sessionName, folderName, state, status, decision }: RunnerSummary): SessionSummary => {
  const sharedStatus = readSessionStatus(status);
  const sharedDecision = readSessionDecision(decision);
  return { sessionName, folderName, state, ...(sharedStatus && { status: sharedStatus }), ...(sharedDecision && { decision: sharedDecision }) };
};

// The same shape on both sides; typed here so a change on either side fails the typecheck.
const toSharedEntry = (entry: RunnerEntry): SessionEntry => entry;

export const toSharedEvent = (runnerEvent: RunnerEvent): SharedRunnerEvent =>
  runnerEvent.type === "sessions"
    ? { type: "sessions", sessions: runnerEvent.sessions.map(toSharedSummary) }
    : { type: "session-entries", sessionName: runnerEvent.sessionName, entries: runnerEvent.entries.map(toSharedEntry) };
