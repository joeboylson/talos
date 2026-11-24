// The caps and safety timeouts the session runner keeps, in one place.

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
  // Messages waiting for their session's turn to be over; the summary lists them.
  maxQueuedMessages: 20,
} as const;
const LIMITS = COPIED_LIMITS;

export const SESSION_LIMITS = {
  ...COPIED_LIMITS,
  // The longest line read from a session's stream: a message's line carries
  // its images.
  maxStreamLineBytes: LIMITS.maxImagesPerMessage * LIMITS.maxImageBase64Length + 4 * 1024 * 1024,
  // A talos that stops reading the runner's events gets cut off once this many
  // chunks wait for it, instead of the session runner holding everything it hasn't read.
  maxStreamBacklogChunks: 1024,
  // The control socket carries a message with up to four images, so the same
  // cap as a socket message to the server.
  maxControlBodyBytes: LIMITS.maxSocketMessageBytes,
  // Rapid session state and ask changes collapse into one roster broadcast per this
  // window, so a session flapping its state can't flood the runner → talos uplink.
  sessionsBroadcastCoalesceMs: 100,
  // Open files each Claude session (and everything it starts) may have: plenty
  // for real work, and it can't be raised from inside, so one session can't open
  // enough connections to use up the session runner's.
  maxSessionOpenFiles: 2048,
  // Outputs taken that wait for their call to be read from the conversation.
  // Well past maxOpenOutputs, since one message can send many at once; each
  // carries its fields, so not unbounded.
  maxOutputsInFlight: 100,
  // Calls read from the conversation that wait for their output. Each is only an
  // id and a number, and calls that were denied wait too.
  maxWaitingPlaces: 500,
  // The runner's log is moved to runner.log.1 past this, when a runner starts.
  maxRunnerLogBytes: 10 * 1024 * 1024,
  // Most a session's open outputs add to the session list it sends.
  maxSummaryOutputsBytes: 32 * 1024,
  // The file that keeps items dropped for failing their check.
  maxQuarantineBytes: 1024 * 1024,
  // A session whose Claude Code hasn't reported its start by this long after it
  // was spawned is shown as needing the person.
  startLongestWaitMs: 60_000,
  // An asked-for turn that goes unanswered this long becomes "no response".
  askTimeoutMs: 60_000,
  // An ask queued behind a busy session waits this long for it to go idle: long
  // enough for real work, short enough that a session stuck waiting on the person
  // doesn't block asks for good.
  queuedAskTimeoutMs: 30 * 60_000,
  // A post from a session's mod is parsed on the runner's one thread, so it's
  // capped: a prompt's text or a tool call's input is the big part.
  maxLinkBodyBytes: 4 * 1024 * 1024,
  // How often the runner looks for a mod gone quiet.
  linkCheckMs: 5_000,
  // A mod that sends nothing for this long counts as gone. It sends word every
  // 5 s, so this allows for a few missed.
  linkSilenceMs: 20_000,
} as const;
