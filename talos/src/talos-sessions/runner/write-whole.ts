// Saves a small file whole: written beside it, then swapped in, so a crash
// leaves the old file or the new one, never half. Done in one step, so two
// saves can't land out of order either.
import { renameSync, writeFileSync } from "node:fs";

export const writeWhole = (file: string, text: string): void => {
  const newFile = `${file}.${process.pid}.new`;
  writeFileSync(newFile, text, { mode: 0o600 });
  renameSync(newFile, file);
};
