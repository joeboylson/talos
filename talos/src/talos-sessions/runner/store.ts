// The session runner's state: the sessions it holds, one record each, and who is
// listening for events. Every other runner file reads and changes sessions here.
import type { Subprocess } from "bun";
import type { SessionEntry, SessionSummary } from "../shapes";
import { createCoalescer } from "../coalescer";
import { encodeRunnerEvent, type RunnerEvent } from "../client/runner-protocol";
import type { Lane } from "../lanes/lane";
import type { OutputPlacing, Outputs } from "../lanes/outputs";
import type { HeldAnswer } from "../lanes/held";
import type { TrustChange } from "../claude/claude-trust";
import type { FactView } from "../link/fact-state";
import { SESSION_LIMITS } from "../limits";

export type Terminal = { write: (data: string | Uint8Array) => void; resize: (cols: number, rows: number) => void };

export type ToolEntry = Extract<SessionEntry, { kind: "tool" }>;

export type TypedMessage = { text: string; hasImages: boolean; imagePaths?: readonly string[] };

// Where a session's conversation is saved, how much of it has been read, and
// the tools seen there that haven't ended yet.
export type Transcript = { path: string; readByteCount: number; runningTools: Map<string, ToolEntry> };

// A session's link to its mod (see link-server.ts). The token is good for one
// check-in, which gives the secret; commands is the helper's open stream.
export type SessionLink = {
  token: string;
  isCheckedIn: boolean;
  secret: string | null;
  lastSeq: number;
  commands: ReadableStreamDefaultController<string> | null;
  // The session's state worked out from facts alone, and when the mod last sent
  // anything (a heartbeat included), on the steady clock.
  factView: FactView;
  lastHeardAtMs: number;
};

export type HeldSession = {
  summary: SessionSummary;
  path: string;
  child: Subprocess;
  terminal: Terminal;
  // Messages sent before Claude Code finished starting; typed once it's ready.
  queuedMessages: TypedMessage[];
  // The conversation files read so far, the one Claude Code writes now last.
  // Older ones are still read to their end, and one it comes back to carries on
  // where it stopped.
  transcripts: Transcript[];
  entries: SessionEntry[];
  lane: Lane;
  outputs: Outputs;
  // The next number in the conversation, and outputs waiting for their place.
  nextPosition: number;
  placing: OutputPlacing;
  heldAnswers: HeldAnswer[];
  // Proves a hook POST on the shared hooks socket came from this session.
  hookToken: string;
  link: SessionLink;
  // When it started, on the wall clock: saved with its process group, so a
  // later runner can tell a recent group from a number reused since.
  startedAtMs: number;
  // Unsent text the person left in Claude Code's input box from an attached
  // terminal. A request talos types mustn't be pasted onto it.
  hasDraft: boolean;
  // When a key last changed the draft, so one the key checks lost track of
  // stops counting after a while.
  draftAtMs: number;
  // The session's last turn has ended, by its mod's facts, as opposed to "needs
  // you" for a permission prompt mid-turn. Only then may a request be typed:
  // Enter in a permission prompt would approve it. talos clears it as it types,
  // before the turn's own start arrives, so nothing else types over it.
  isTurnOver: boolean;
  // talos typed the next turn (an answer, an asked-for request), until it
  // starts or the person types over it.
  isTalosTypedNext: boolean;
  // The most recent terminal output, so someone attaching sees the screen.
  output: Uint8Array;
  // Attached terminals. A Set kept by reference: streams add and remove
  // themselves as they open and close.
  outputListeners: Set<ReadableStreamDefaultController<Uint8Array>>;
  // One of each at a time: a transcript read, so lines aren't read twice, and
  // typing what waits for the turn to be over.
  isBeingRead: boolean;
  isWaitingToAsk: boolean;
};

export const heldSessions = new Map<string, HeldSession>();
export const eventListeners = new Set<ReadableStreamDefaultController<string>>();
// The trust settings this session runner changed, to put back when it stops.
export const trustChanges: TrustChange[] = [];
// Sessions whose start is under way, by name, so a stop can wait for one; and
// whether the runner is stopping, when it takes no new sessions.
export const startingSessions = new Map<string, Promise<Response>>();
// The mod snapshot sessions load (see mod-snapshot.ts), made at the runner's start.
// Why no session can start, if none can: no tested Claude Code to run.
// The Claude Code version a session's mod must report, when the runner runs
// the pinned copy (a test's stand-in reports its own).
export const runnerState = { isStopping: false, modSnapshotFolder: "", cannotStartWhy: null as string | null, expectedClaudeVersion: null as string | null };

// Changes a held session only while it's the same instance (same hook token),
// so a loop or read left over from a session that ended never touches a new
// one started under its name.
export const updateHeldSession = (sessionName: string, token: string, change: Partial<HeldSession>) => {
  const session = heldSessions.get(sessionName);
  if (session?.hookToken === token) heldSessions.set(sessionName, { ...session, ...change });
};

export const listSessions = (): SessionSummary[] => [...heldSessions.values()].map((session) => session.summary);

// Sends a chunk to every listener, cutting off one too far behind (it stopped
// reading), so the session runner never holds an unbounded backlog for it.
export const sendToListeners = <T>(listeners: Set<ReadableStreamDefaultController<T>>, chunk: T) =>
  listeners.forEach((listener) => {
    const isTooFarBehind = (listener.desiredSize ?? 0) < -SESSION_LIMITS.maxStreamBacklogChunks;
    if (!isTooFarBehind) return listener.enqueue(chunk);
    listeners.delete(listener);
    listener.error(new Error("stopped reading"));
  });

export const broadcast = (runnerEvent: RunnerEvent) => sendToListeners(eventListeners, encodeRunnerEvent(runnerEvent));

// Coalesced: rapid state and ask changes (a session can flap its own state via
// forged hooks) collapse into one roster broadcast per window, so the uplink
// (runner → talos → server) can't be flooded. The run sends the latest list.
export const broadcastSessions = createCoalescer(
  () => broadcast({ type: "sessions", sessions: listSessions() }),
  SESSION_LIMITS.sessionsBroadcastCoalesceMs,
);

// One thing types into a session at a time (a message, talos's answer or
// request, the person's keys): one typed during another's pauses would join
// it, and glue its text onto the other's.
const typing = new Map<string, Promise<unknown>>();
export const typeInTurn = <T>(sessionName: string, type: () => Promise<T>): Promise<T> => {
  const typed = (typing.get(sessionName) ?? Promise.resolve()).then(type);
  const settled = typed.catch(() => {});
  typing.set(sessionName, settled);
  void settled.then(() => typing.get(sessionName) === settled && typing.delete(sessionName));
  return typed;
};

// A permission prompt shows: Claude Code waits on the person mid-turn.
export const isPromptShowing = (session: HeldSession): boolean => session.summary.state === "needs-you" && !session.isTurnOver;
