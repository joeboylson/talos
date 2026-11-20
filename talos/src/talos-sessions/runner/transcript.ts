// Reading each session's saved conversation as Claude Code writes it.
import { LIMITS, mergeSessionEntries } from "talos-shared";
import { isPlainTranscriptFile } from "../transcript/transcript-file";
import { readCompleteLines, readTranscriptLine, resolveTranscriptItems } from "../transcript/transcript-lines";
import { log } from "./log";
import { broadcast, heldSessions, updateHeldSession } from "./store";
import { SESSION_LIMITS } from "../limits";

const readNewEntries = async (sessionName: string): Promise<void> => {
  const transcript = heldSessions.get(sessionName)?.transcript;
  if (!transcript) return;
  // Don't follow a non-regular file (e.g. a symlink a session planted in its own
  // transcript dir, whose lexical dirname passes allowTranscriptSwitch) — reading
  // its target would show another file's content as this session's conversation.
  if (!(await isPlainTranscriptFile(transcript.path))) return;
  const transcriptFile = Bun.file(transcript.path);
  if (transcriptFile.size <= transcript.readByteCount) return;

  // Read at most a bounded chunk per poll, so a session can't make one read
  // allocate and parse its whole (possibly huge) transcript at once and OOM or
  // stall the session runner. A big backlog drains over several polls.
  const chunkEnd = transcript.readByteCount + Math.min(transcriptFile.size - transcript.readByteCount, SESSION_LIMITS.maxTranscriptReadBytes);
  const newBytes = new Uint8Array(await transcriptFile.slice(transcript.readByteCount, chunkEnd).arrayBuffer());
  const { lines, usedByteCount } = readCompleteLines(newBytes);
  if (usedByteCount === 0) {
    // No complete line in the chunk. If the file has already grown past it, a
    // single line is longer than the cap (pathological) — skip the chunk instead
    // of reading the whole remainder, so one huge line can't OOM the session runner; its
    // fragments then fail to parse and drop. Otherwise it's an incomplete trailing
    // line still being written: wait for the next poll.
    if (chunkEnd < transcriptFile.size) {
      const current = heldSessions.get(sessionName);
      if (current?.transcript?.path === transcript.path) {
        heldSessions.set(sessionName, { ...current, transcript: { ...current.transcript, readByteCount: chunkEnd } });
      }
    }
    return;
  }
  const { entries, knownTools } = resolveTranscriptItems(lines.flatMap(readTranscriptLine), transcript.runningTools);

  const session = heldSessions.get(sessionName);
  if (!session || session.transcript?.path !== transcript.path) return;
  heldSessions.set(sessionName, {
    ...session,
    transcript: { ...transcript, readByteCount: transcript.readByteCount + usedByteCount, runningTools: knownTools },
    entries: mergeSessionEntries(session.entries, entries, LIMITS.maxEntriesKept),
  });
  // One read can make more entries than a list may hold (a resumed session's
  // whole file), and an over-long list is turned down whole. Cut it the way the
  // kept list is cut, after a tool's end replaces its start, so talos gets every
  // entry the session runner keeps.
  const sentEntries = mergeSessionEntries([], entries, LIMITS.maxEntriesKept);
  if (sentEntries.length > 0) broadcast({ type: "session-entries", sessionName, entries: sentEntries });
};

// One read at a time per session, so the same lines are never read twice.
export const readAllNewEntries = () =>
  [...heldSessions.values()]
    .filter((session) => !session.isBeingRead)
    .forEach(({ summary: { sessionName }, hookToken }) => {
      updateHeldSession(sessionName, hookToken, { isBeingRead: true });
      readNewEntries(sessionName)
        .catch((error: unknown) => log.warn(`runner: couldn't read ${sessionName}'s conversation: ${error}`))
        .finally(() => updateHeldSession(sessionName, hookToken, { isBeingRead: false }));
    });
