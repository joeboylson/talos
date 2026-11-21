// Items that failed their check are kept here, never sent on, so the owner can
// see what went wrong. Only this user can read the file, it's capped (one older
// copy is kept), and it's written off the session runner's main path.
import { appendFile, chmod, rename, stat } from "node:fs/promises";
import { SESSION_LIMITS } from "../limits";
import { log, paths } from "./inputs";

const quarantineFile_MODE = 0o600;

const writeLines = async (lines: string): Promise<void> => {
  const quarantineFile = paths().quarantine;
  const size = await stat(quarantineFile).then((info) => info.size, () => 0);
  if (size + lines.length > SESSION_LIMITS.maxQuarantineBytes) await rename(quarantineFile, `${quarantineFile}.1`).catch(() => {});
  await appendFile(quarantineFile, lines, { mode: quarantineFile_MODE });
  await chmod(quarantineFile, quarantineFile_MODE);
};

// One write at a time, so a rotation can't race another write.
let writing: Promise<void> = Promise.resolve();

export const quarantine = (sessionName: string, items: readonly unknown[]): void => {
  if (items.length === 0) return;
  const atMs = Date.now();
  const lines = items
    .map((item) => JSON.stringify({ atMs, sessionName, item }).slice(0, SESSION_LIMITS.maxQuarantineBytes / 4))
    .join("\n");
  writing = writing
    .then(() => writeLines(`${lines}\n`))
    .catch((error: unknown) => log.warn(`runner: couldn't keep ${sessionName}'s dropped items: ${error}`));
};
