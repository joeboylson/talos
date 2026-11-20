import { lstat } from "node:fs/promises";

// Whether a path is a plain regular file the session runner may read as a transcript. A
// real Claude Code transcript always is; a symlink or directory is not. This is
// checked (with lstat, which does NOT follow the final symlink) right before each
// read, so a session can't plant a symlink in its own transcript dir — whose
// lexical dirname matches, passing allowTranscriptSwitch — that points at another
// session's transcript or any other file and have its content read and shown as
// this session's conversation and status. Re-checking every poll also closes the
// swap-after-check race.
export const isPlainTranscriptFile = async (path: string): Promise<boolean> =>
  (await lstat(path).catch(() => null))?.isFile() ?? false;
