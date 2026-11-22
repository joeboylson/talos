// Saves a small file whole: written beside it, on disk (fsync), then swapped
// in, so a crash or a power cut leaves the old file or the new one, never half.
// Done in one step, so two saves can't land out of order either.
import { closeSync, fsyncSync, openSync, renameSync, writeSync } from "node:fs";

export const writeWhole = (file: string, text: string): void => {
  const newFile = `${file}.${process.pid}.new`;
  const handle = openSync(newFile, "w", 0o600);
  try {
    writeSync(handle, text);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(newFile, file);
};
