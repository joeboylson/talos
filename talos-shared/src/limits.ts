// Every size, count and length both sides check, in one place. Each is a cap
// against something too big arriving, from a page, a machine or a session.
const MAX_SOCKET_MESSAGE_BYTES = 16 * 1024 * 1024;

export const LIMITS = {
  // Socket messages carry at most four images (about 12 MB as text), so 16 MB
  // covers them with room to spare. The server closes a socket that sends more.
  maxSocketMessageBytes: MAX_SOCKET_MESSAGE_BYTES,
  // Each socket may make the server parse at most this many message bytes per
  // window; beyond it, messages are dropped before parsing, so one connection
  // can't flood large frames and starve the shared thread for other owners. Well
  // above legit traffic (an image message is ~12MB, an entry burst ~13MB/s).
  socketIngressWindowMs: 1000,
  maxSocketIngressBytes: 32 * 1024 * 1024,
  // Entry lists go in batches of at most this size, well under the message limit,
  // so a session's whole kept history never makes one oversized message.
  maxEntriesBatchBytes: MAX_SOCKET_MESSAGE_BYTES / 4,

  maxSessions: 50,
  // Each side keeps this many of a session's latest entries, and sends at most
  // this many at once.
  maxEntriesKept: 500,
  // Longer text is cut to this. It keeps a session's kept entries to a few MB on
  // the host, in talos and on the server.
  maxEntryTextLength: 20_000,
  // A message typed on the page can be longer (a pasted log): it goes once to
  // the session and isn't kept.
  maxSentTextLength: 100_000,
  maxStatusNoteLength: 280,
  maxToolSummaryLength: 1000,
  maxIdTextLength: 200,
  maxNameTextLength: 100,
  // The page shrinks images before sending, so these are rarely reached.
  maxImagesPerMessage: 4,
  maxImageBase64Length: 3_000_000,
  maxFolders: 200,
  maxPathLength: 4096,
  maxIdentifierLength: 40,
} as const;
