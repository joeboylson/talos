// The host's state: the sessions it holds, one record each, and who is
// listening for events. Every other host file reads and changes sessions here.
import type { Subprocess } from "bun";
import type { SessionEntry, SessionSummary } from "talos-shared";
import { createCoalescer } from "../coalescer";
import { encodeHostEvent, type HostEvent } from "../host-protocol";
import type { StatusLane } from "../status-lane";
import { TALOS_LIMITS } from "../limits";

export type Terminal = { write: (data: string | Uint8Array) => void; resize: (cols: number, rows: number) => void };

export type ToolEntry = Extract<SessionEntry, { kind: "tool" }>;

export type TypedMessage = { text: string; hasImages: boolean };

// Where a session's conversation is saved, how much of it has been read, and
// the tools seen there that haven't ended yet.
export type Transcript = { path: string; readByteCount: number; runningTools: Map<string, ToolEntry> };

export type HeldSession = {
  summary: SessionSummary;
  path: string;
  child: Subprocess;
  terminal: Terminal;
  // Messages sent before Claude Code finished starting; typed once it's ready.
  queuedMessages: TypedMessage[];
  transcript: Transcript | null;
  entries: SessionEntry[];
  statusLane: StatusLane;
  // Proves a hook POST on the shared hooks socket came from this session.
  hookToken: string;
  // Unsent text the person left in Claude Code's input box from an attached
  // terminal. The status request mustn't be pasted onto it.
  hasDraft: boolean;
  // The most recent terminal output, so someone attaching sees the screen, and
  // when it last changed, to tell when the screen has settled.
  output: Uint8Array;
  lastOutputAtMs: number;
  // Attached terminals. A Set kept by reference: streams add and remove
  // themselves as they open and close.
  outputListeners: Set<ReadableStreamDefaultController<Uint8Array>>;
  // One of each loop at a time: a transcript read, so lines aren't read twice; a
  // ready wait, so a forged flood of SessionStart events can't pile up loops; and
  // a settle wait for a queued status ask.
  isBeingRead: boolean;
  isBecomingReady: boolean;
  isWaitingToAsk: boolean;
};

export const heldSessions = new Map<string, HeldSession>();
export const eventListeners = new Set<ReadableStreamDefaultController<string>>();

// Changes a held session only while it's the same instance (same hook token),
// so a loop or read left over from a session that ended never touches a new
// one started under its name.
export const updateHeldSession = (sessionName: string, token: string, change: Partial<HeldSession>) => {
  const session = heldSessions.get(sessionName);
  if (session?.hookToken === token) heldSessions.set(sessionName, { ...session, ...change });
};

export const listSessions = (): SessionSummary[] => [...heldSessions.values()].map((session) => session.summary);

export const broadcast = (hostEvent: HostEvent) => {
  const line = encodeHostEvent(hostEvent);
  eventListeners.forEach((listener) => listener.enqueue(line));
};

// Coalesced: rapid state/status changes (a session can flap its own state via
// forged hooks) collapse into one roster broadcast per window, so the uplink
// (host→machine→server) can't be flooded. The run sends the latest list.
export const broadcastSessions = createCoalescer(
  () => broadcast({ type: "sessions", sessions: listSessions() }),
  TALOS_LIMITS.sessionsBroadcastCoalesceMs,
);
