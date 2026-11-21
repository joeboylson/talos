// The caps and safety timeouts the session runner and its hooks keep, in one place.

// The module's own copies of limits talos-shared also checks. A talos test
// (session-limits.test.ts) fails if a copy drifts from talos-shared's value.
export const COPIED_LIMITS = {
  maxSessions: 50,
  maxEntriesKept: 500,
  maxDroppedPerBatch: 10,
  maxDroppedKept: 20,
  maxKeptEntryTextLength: 200_000,
  maxEntryTextLength: 20_000,
  maxToolSummaryLength: 1000,
  maxIdTextLength: 200,
  maxNameTextLength: 100,
  maxImagesPerMessage: 4,
  maxImageBase64Length: 3_000_000,
  maxIdentifierLength: 40,
  maxSocketMessageBytes: 16 * 1024 * 1024,
  // Outputs waiting for an answer per session; past it, the oldest closes. Each
  // output's fields are capped too, so the session list stays small.
  maxOpenOutputs: 20,
  maxOutputFieldsBytes: 8 * 1024,
} as const;
const LIMITS = COPIED_LIMITS;

export const SESSION_LIMITS = {
  ...COPIED_LIMITS,
  // A hook request is parsed synchronously on the session runner's one thread, so cap it:
  // a session can't send a huge body that JSON.parse blocks on for seconds (which
  // would make every other session's hook time out and fail open). Real hook requests
  // are small; this leaves generous room for a large tool input.
  maxHookBodyBytes: 4 * 1024 * 1024,
  // Most a single transcript poll reads and parses at once, so one session's large
  // transcript is drained over several polls instead of blocking the session runner in one go.
  // It must hold one whole line, and a prompt's line carries its images.
  maxTranscriptReadBytes: LIMITS.maxImagesPerMessage * LIMITS.maxImageBase64Length + 4 * 1024 * 1024,
  // Conversation files a session's reads keep up with: the current one, and the
  // ones it moved away from (each is checked on every read).
  maxTranscriptsRead: 8,
  // An attached terminal or talos that stops reading gets cut off once this many
  // chunks wait for it, instead of the session runner holding everything it hasn't read.
  maxStreamBacklogChunks: 1024,
  // Terminal sizes a resize may ask for.
  maxTerminalCells: 1000,
  // The control socket carries a message with up to four images, so the same
  // cap as a socket message to the server.
  maxControlBodyBytes: LIMITS.maxSocketMessageBytes,
  // Enough recent output to redraw Claude Code's screen for someone attaching.
  maxOutputBytes: 256 * 1024,
  // Rapid session state and ask changes collapse into one roster broadcast per this
  // window, so a session flapping its state can't flood the runner → talos uplink.
  sessionsBroadcastCoalesceMs: 100,
  // The hook script must never hold Claude up. A hook connection that hasn't
  // sent its whole request in this time is closed too, so idle ones can't pile up.
  hookTimeoutMs: 2000,
  // Hook connections the session runner holds at once; past it, the oldest is closed.
  // Well under the session runner's own file limit, so a flood of connections can't use
  // up the files it needs for the control socket and sessions.
  maxHookConnections: 256,
  // Open files each Claude session (and everything it starts) may have: plenty
  // for real work, and it can't be raised from inside, so one session can't open
  // enough connections to use up the session runner's.
  maxSessionOpenFiles: 2048,
  // Outputs a session has in flight (allowed, not yet in the conversation). Well
  // past maxOpenOutputs, since one message can send many at once; each carries
  // its fields, so not unbounded.
  maxOutputsInFlight: 100,
  // Calls read from the conversation that wait for their output. Each is only an
  // id and a number, and calls that never go through (denied, failed) wait too.
  maxWaitingPlaces: 500,
  // Images kept per session: the newest, since Claude Code reads one when it's
  // pasted; the rest go once there are more.
  maxUploadsKept: 20,
  // Messages sent while a session starts, typed once it's ready.
  maxQueuedMessages: 20,
  // The runner's log is moved to runner.log.1 past this, when a runner starts.
  maxRunnerLogBytes: 10 * 1024 * 1024,
  // A hook with a bad token is logged at most this often, so a flood can't fill the log.
  badTokenLogEveryMs: 1000,
  // Most a session's open outputs add to the session list it sends.
  maxSummaryOutputsBytes: 32 * 1024,
  // The file that keeps items dropped for failing their check.
  maxQuarantineBytes: 1024 * 1024,
  // Past this, a starting session is typed into even if its screen hasn't settled.
  readyLongestWaitMs: 15_000,
  // An asked-for turn that goes unanswered this long becomes "no response".
  askTimeoutMs: 60_000,
  // An ask queued behind a busy session waits this long for it to go idle: long
  // enough for real work, short enough that a session stuck waiting on the person
  // doesn't block asks for good.
  queuedAskTimeoutMs: 30 * 60_000,
} as const;
