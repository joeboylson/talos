// Items that failed their check are kept here, never sent on, so the owner can
// see what went wrong. Only this user can read the file, it's capped (one older
// copy is kept), and it's written off the session runner's main path.
import { appendFile, chmod, rename, stat } from "node:fs/promises";
import { SESSION_LIMITS } from "../limits";
import { log, paths } from "./inputs";

const QUARANTINE_FILE_MODE = 0o600;

// Each item is kept as a short piece of its JSON, so a line is always whole
// JSON however big the item was.
const ITEM_KEPT_LENGTH = 2000;

// The lines for one batch, cut to what the file may hold: one huge batch can't
// write past the cap.
export const quarantineLines = (sessionName: string, items: readonly unknown[], atMs: number): string => {
  const lines = items.map((item) => `${JSON.stringify({ atMs, sessionName, item: String(JSON.stringify(item)).slice(0, ITEM_KEPT_LENGTH) })}\n`);
  const fits = lines.reduce<{ kept: string[]; bytes: number }>(
    (sum, line) => {
      const bytes = sum.bytes + Buffer.byteLength(line);
      return bytes > SESSION_LIMITS.maxQuarantineBytes ? sum : { kept: [...sum.kept, line], bytes };
    },
    { kept: [], bytes: 0 },
  );
  return fits.kept.join("");
};

const writeLines = async (lines: string): Promise<void> => {
  const quarantineFile = paths().quarantine;
  const size = await stat(quarantineFile).then((info) => info.size, () => 0);
  if (size + Buffer.byteLength(lines) > SESSION_LIMITS.maxQuarantineBytes) await rename(quarantineFile, `${quarantineFile}.1`).catch(() => {});
  await appendFile(quarantineFile, lines, { mode: QUARANTINE_FILE_MODE });
  await chmod(quarantineFile, QUARANTINE_FILE_MODE);
};

// One write at a time, so a rotation can't race another write.
let writing: Promise<void> = Promise.resolve();

export const quarantine = (sessionName: string, items: readonly unknown[]): void => {
  const lines = quarantineLines(sessionName, items, Date.now());
  if (!lines) return;
  writing = writing.then(() => writeLines(lines)).catch((error: unknown) => log.warn(`runner: couldn't keep ${sessionName}'s dropped items: ${error}`));
};
