// The caps and safety timeouts talos and its session host keep for themselves,
// in one place. Limits both sides check live in talos-shared's LIMITS.
import { LIMITS } from "talos-shared";

export const TALOS_LIMITS = {
  // A hook POST body is parsed synchronously on the host's one thread, so cap it:
  // a session can't send a huge body that JSON.parse blocks on for seconds (which
  // would make every other session's hook time out and fail open). Real hook bodies
  // are small; this leaves generous room for a large tool input.
  maxHookBodyBytes: 4 * 1024 * 1024,
  // Most a single transcript poll reads and parses at once, so one session's large
  // transcript is drained over several polls instead of blocking the host in one go.
  // It must hold one whole line, and a prompt's line carries its images.
  maxTranscriptReadBytes: LIMITS.maxImagesPerMessage * LIMITS.maxImageBase64Length + 4 * 1024 * 1024,
  // An attached terminal or talos that stops reading gets cut off once this many
  // chunks wait for it, instead of the host holding everything it hasn't read.
  maxStreamBacklogChunks: 1024,
  // Terminal sizes a resize may ask for.
  maxTerminalCells: 1000,
  // The control socket carries a message with up to four images, so the same
  // cap as a socket message to the server.
  maxControlBodyBytes: LIMITS.maxSocketMessageBytes,
  // Enough recent output to redraw Claude Code's screen for someone attaching.
  maxOutputBytes: 256 * 1024,
  // Rapid session state/status changes collapse into one roster broadcast per this
  // window, so a session flapping its state can't flood the host→server uplink.
  sessionsBroadcastCoalesceMs: 100,
  // The hook script must never hold Claude up. A hook connection that hasn't
  // sent its whole request in this time is closed too, so idle ones can't pile up.
  hookTimeoutMs: 2000,
  // Hook connections the host holds at once; past it, the oldest is closed.
  // Well under the host's own file limit, so a flood of connections can't use
  // up the files it needs for the control socket and sessions.
  maxHookConnections: 256,
  // Open files each Claude session (and everything it starts) may have: plenty
  // for real work, and it can't be raised from inside, so one session can't open
  // enough connections to use up the host's.
  maxSessionOpenFiles: 2048,
  // Past this, a starting session is typed into even if its screen hasn't settled.
  readyLongestWaitMs: 15_000,
  // A status request that goes unanswered this long becomes "no response".
  statusTimeoutMs: 60_000,
  // An ask queued behind a busy session waits this long for it to go idle: long
  // enough for real work, short enough that a session stuck waiting on the person
  // doesn't block asks for good.
  queuedStatusTimeoutMs: 30 * 60_000,
  // A reconnect sends each session's kept entries again, at most this many bytes
  // per millisecond: half the server's per-socket budget, so live traffic still
  // fits and the server drops nothing.
  resendBytesPerMs: LIMITS.maxSocketIngressBytes / LIMITS.socketIngressWindowMs / 2,
} as const;
