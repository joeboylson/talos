// Reading each session's saved conversation as Claude Code writes it.
import { mergeSessionEntries } from "../shapes";
import { isPlainTranscriptFile } from "../transcript/transcript-file";
import { numberItems, readCompleteLines, readTranscriptLine, resolveTranscriptItems } from "../transcript/transcript-lines";
import { placeOutputEntries } from "./session-state";
import { log } from "./inputs";
import { quarantine } from "./quarantine";
import { broadcast, heldSessions, updateHeldSession, type Transcript } from "./store";
import { SESSION_LIMITS } from "../limits";

// The file Claude Code moved to becomes the current one (last), keeping how far
// it was read if it was read before. The oldest past the cap stop being read.
export const switchTranscript = (transcripts: readonly Transcript[], path: string): Transcript[] => {
  const known = transcripts.find((transcript) => transcript.path === path);
  const others = transcripts.filter((transcript) => transcript !== known);
  return [...others, known ?? { path, readByteCount: 0, runningTools: new Map() }].slice(-SESSION_LIMITS.maxTranscriptsRead);
};

const withTranscript = (transcripts: readonly Transcript[], changed: Transcript): Transcript[] =>
  transcripts.map((transcript) => (transcript.path === changed.path ? changed : transcript));

const readNewEntries = async (sessionName: string, path: string): Promise<void> => {
  const transcript = heldSessions.get(sessionName)?.transcripts.find((one) => one.path === path);
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
      if (current) heldSessions.set(sessionName, { ...current, transcripts: withTranscript(current.transcripts, { ...transcript, readByteCount: chunkEnd }) });
    }
    return;
  }
  const session = heldSessions.get(sessionName);
  if (!session) return;
  const { items, nextPosition } = numberItems(lines.flatMap(readTranscriptLine), session.nextPosition);
  const { entries, knownTools, rejected, structuredCalls } = resolveTranscriptItems(items, transcript.runningTools);
  quarantine(sessionName, rejected);
  heldSessions.set(sessionName, {
    ...session,
    nextPosition,
    transcripts: withTranscript(session.transcripts, { ...transcript, readByteCount: transcript.readByteCount + usedByteCount, runningTools: knownTools }),
    entries: mergeSessionEntries(session.entries, entries, SESSION_LIMITS.maxEntriesKept),
  });
  // One read can make more entries than a list may hold (a resumed session's
  // whole file), and an over-long list is turned down whole. Cut it the way the
  // kept list is cut, after a tool's end replaces its start, so talos gets every
  // entry the session runner keeps.
  const sentEntries = mergeSessionEntries([], entries, SESSION_LIMITS.maxEntriesKept);
  if (sentEntries.length > 0) broadcast({ type: "session-entries", sessionName, entries: sentEntries });
  placeOutputEntries(sessionName, [], structuredCalls);
};

// Each file in turn, oldest first, so lines a file got just before Claude Code
// left it come before the new file's.
const readSessionEntries = async (sessionName: string, paths: readonly string[]): Promise<void> => {
  for (const path of paths) await readNewEntries(sessionName, path);
};

// One read at a time per session, so the same lines are never read twice.
export const readAllNewEntries = () =>
  [...heldSessions.values()]
    .filter((session) => !session.isBeingRead)
    .forEach(({ summary: { sessionName }, heldId, transcripts }) => {
      updateHeldSession(sessionName, heldId, { isBeingRead: true });
      readSessionEntries(sessionName, transcripts.map(({ path }) => path))
        .catch((error: unknown) => log.warn(`runner: couldn't read ${sessionName}'s conversation: ${error}`))
        .finally(() => updateHeldSession(sessionName, heldId, { isBeingRead: false }));
    });
