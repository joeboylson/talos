// Turns what talos-sessions hands out into talos-shared's shapes before it goes
// to the server and the page. The module knows nothing of talos-shared, so this
// is the one place the two meet.
import { readSessionDecision, readSessionStatus, type SessionEntry, type SessionStatus, type SessionSummary } from "talos-shared";
import { DECISION_KIND, STATUS_KIND } from "./session-outputs";
import type { RunnerEvent, SessionEntry as RunnerEntry, SessionSummary as RunnerSummary } from "./talos-sessions";

export type SharedRunnerEvent =
  | { type: "sessions"; sessions: SessionSummary[] }
  | { type: "session-entries"; sessionName: string; entries: SessionEntry[] };

// The module keeps an ask's state and each kind's fields; the page still reads
// them as a status and a decision. Those fields are talos's own kinds, so the
// module passes them through unchecked and they're checked here. A bad one is left out.
const toSharedStatus = (ask: RunnerSummary["asks"][string] | undefined): SessionStatus | null => {
  if (!ask) return null;
  if (ask.state === "asking") return { state: "pending", note: "", atMs: ask.atMs };
  if (ask.state === "no-response") return { state: "no-response", note: "", atMs: ask.atMs };
  return readSessionStatus({ ...ask.latest, atMs: ask.atMs });
};

const toSharedSummary = ({ sessionName, folderName, state, asks, openOutputs }: RunnerSummary): SessionSummary => {
  const status = toSharedStatus(asks[STATUS_KIND.kind]);
  const openDecision = openOutputs.find((output) => output.kind === DECISION_KIND.kind);
  const decision = openDecision ? readSessionDecision({ ...openDecision.fields, atMs: openDecision.atMs }) : null;
  return { sessionName, folderName, state, ...(status && { status }), ...(decision && { decision }) };
};

// The same shape on both sides; typed here so a change on either side fails the typecheck.
const toSharedEntry = (entry: RunnerEntry): SessionEntry => entry;

export const toSharedEvent = (runnerEvent: RunnerEvent): SharedRunnerEvent =>
  runnerEvent.type === "sessions"
    ? { type: "sessions", sessions: runnerEvent.sessions.map(toSharedSummary) }
    : { type: "session-entries", sessionName: runnerEvent.sessionName, entries: runnerEvent.entries.map(toSharedEntry) };
