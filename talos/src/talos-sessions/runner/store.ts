// The session runner's state: the sessions it holds, one record each, and who is
// listening for events. Every other runner file reads and changes sessions here.
import type { Subprocess } from "bun";
import type { SentImage, SessionEntry, SessionSummary } from "../shapes";
import { createCoalescer } from "../coalescer";
import { encodeRunnerEvent, type RunnerEvent } from "../client/runner-protocol";
import type { Lane } from "../lanes/lane";
import type { OutputPlacing, Outputs } from "../lanes/outputs";
import type { HeldAnswer } from "../lanes/held";
import type { TrustChange } from "../claude/claude-trust";
import { SESSION_LIMITS } from "../limits";

export type ToolEntry = Extract<SessionEntry, { kind: "tool" }>;

// A message from the page waiting for the turn to be over: its text and
// images, and the page's request id, to give it back by.
export type WaitingMessage = { text: string; images: readonly SentImage[]; requestId?: string };

// A permission question Claude Code put on its stream, waiting for an answer:
// the stream's request, the tool call it's about, and a line saying what the
// call would do.
export type WaitingPermission = { requestId: string; toolUseId: string; tool: string; input: unknown; summary: string };

// A session's link to its mod (see link-server.ts). The token is good for one
// check-in, which gives the secret; commands is the helper's open stream.
export type SessionLink = {
  token: string;
  isCheckedIn: boolean;
  secret: string | null;
  lastSeq: number;
  commands: ReadableStreamDefaultController<string> | null;
  // When the mod last sent anything (a heartbeat included), on the steady clock.
  lastHeardAtMs: number;
};

export type HeldSession = {
  summary: SessionSummary;
  path: string;
  // Claude Code, run headless: talos writes to its input and reads its stream.
  child: Subprocess<"pipe", "pipe", "pipe">;
  // Messages from the page, oldest first, waiting for the turn to be over: one
  // goes in per turn.
  queuedMessages: WaitingMessage[];
  entries: SessionEntry[];
  // Tools seen in the conversation that haven't ended yet.
  runningTools: Map<string, ToolEntry>;
  waitingPermissions: WaitingPermission[];
  lane: Lane;
  outputs: Outputs;
  // The next number in the conversation, and outputs waiting for their place.
  nextPosition: number;
  placing: OutputPlacing;
  heldAnswers: HeldAnswer[];
  // Which held session this is: a new one started under the same name gets
  // a new one.
  heldId: string;
  link: SessionLink;
  // When it started, on the wall clock: saved with its process group, so a
  // later runner can tell a recent group from a number reused since.
  startedAtMs: number;
  // The session's last turn has ended (its result came), as opposed to "needs
  // you" for a permission question mid-turn. Only then does a message go in:
  // one written mid-turn would join the turn that's running. talos clears it
  // as it writes, so nothing else goes in over it.
  isTurnOver: boolean;
  // talos interrupted the running turn: its end doesn't close a question.
  isInterrupting: boolean;
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

// Changes a held session only while it's the same instance (same heldId),
// so a loop or read left over from a session that ended never touches a new
// one started under its name.
export const updateHeldSession = (sessionName: string, token: string, change: Partial<HeldSession>) => {
  const session = heldSessions.get(sessionName);
  if (session?.heldId === token) heldSessions.set(sessionName, { ...session, ...change });
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

// Coalesced: rapid state and ask changes collapse into one roster broadcast per window, so the uplink
// (runner → talos → server) can't be flooded. The run sends the latest list.
export const broadcastSessions = createCoalescer(
  () => broadcast({ type: "sessions", sessions: listSessions() }),
  SESSION_LIMITS.sessionsBroadcastCoalesceMs,
);
