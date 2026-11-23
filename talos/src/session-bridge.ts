// Turns what talos-sessions hands out into talos-shared's shapes before it goes
// to the server and the page. The module knows nothing of talos-shared, so this
// is the one place the two meet.
import type { SessionEntry, SessionSummary } from "talos-shared";
import type { RunnerEvent, SessionEntry as RunnerEntry, SessionSummary as RunnerSummary } from "./talos-sessions";

export type SharedRunnerEvent =
  | { type: "sessions"; sessions: SessionSummary[] }
  | { type: "session-entries"; sessionName: string; entries: SessionEntry[] }
  | { type: "notice"; sessionName: string; message: string };

// The module's summary is the shared one's general shape; its kinds' fields are
// checked where they're read (talos-shared's statusOf and openDecisionOf).
const toSharedSummary = ({ sessionName, folderName, state, asks, openOutputs, isTurnOver, link, isSelfStarted }: RunnerSummary): SessionSummary => ({
  sessionName,
  folderName,
  state,
  asks,
  openOutputs,
  ...(isTurnOver !== undefined && { isTurnOver }),
  ...(link && { link }),
  ...(isSelfStarted && { isSelfStarted }),
});

// The same shape on both sides; typed here so a change on either side fails the typecheck.
const toSharedEntry = (entry: RunnerEntry): SessionEntry => entry;

export const toSharedEvent = (runnerEvent: RunnerEvent): SharedRunnerEvent => {
  if (runnerEvent.type === "sessions") return { type: "sessions", sessions: runnerEvent.sessions.map(toSharedSummary) };
  if (runnerEvent.type === "notice") return runnerEvent;
  return { type: "session-entries", sessionName: runnerEvent.sessionName, entries: runnerEvent.entries.map(toSharedEntry) };
};
