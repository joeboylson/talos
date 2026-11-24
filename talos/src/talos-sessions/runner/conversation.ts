// A session's conversation, as its stream gives it: numbered, checked, kept,
// and sent to whoever follows the runner.
import { mergeSessionEntries } from "../shapes";
import { numberItems, resolveTranscriptItems, type TranscriptItem } from "../transcript/transcript-lines";
import { SESSION_LIMITS } from "../limits";
import { quarantine } from "./quarantine";
import { placeOutputEntries } from "./session-state";
import { broadcast, heldSessions } from "./store";

export const addConversation = (sessionName: string, items: readonly TranscriptItem[]): void => {
  const session = heldSessions.get(sessionName);
  if (!session || items.length === 0) return;
  const { items: numbered, nextPosition } = numberItems([...items], session.nextPosition);
  const { entries, knownTools, rejected, structuredCalls } = resolveTranscriptItems(numbered, session.runningTools);
  quarantine(sessionName, rejected);
  heldSessions.set(sessionName, {
    ...session,
    nextPosition,
    runningTools: knownTools,
    entries: mergeSessionEntries(session.entries, entries, SESSION_LIMITS.maxEntriesKept),
  });
  // Cut the way the kept list is cut, so talos gets every entry the runner keeps.
  const sentEntries = mergeSessionEntries([], entries, SESSION_LIMITS.maxEntriesKept);
  if (sentEntries.length > 0) broadcast({ type: "session-entries", sessionName, entries: sentEntries });
  placeOutputEntries(sessionName, [], structuredCalls);
};
