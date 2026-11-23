// talos's own folder (~/.talos) holds the machine's key and the folders
// sessions may run in, so it's this user's own folder, closed to everyone
// else, and its files are written privately and whole.
import { chmod, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { CREDENTIALS_FILE_MODE, CREDENTIALS_FOLDER, CREDENTIALS_FOLDER_MODE } from "./constants";

// mkdir sets the mode only when it makes the folder, so one made before is
// checked and closed here.
export const claimTalosFolder = async (): Promise<void> => {
  await mkdir(CREDENTIALS_FOLDER, { recursive: true, mode: CREDENTIALS_FOLDER_MODE });
  const info = await lstat(CREDENTIALS_FOLDER);
  if (!info.isDirectory() || info.uid !== process.getuid?.()) throw new Error(`${CREDENTIALS_FOLDER} isn't a folder of this user's own`);
  await chmod(CREDENTIALS_FOLDER, CREDENTIALS_FOLDER_MODE);
};

// A new file only this user can read, swapped in whole: never open to others
// for a moment, and a link planted at the path is replaced, not written through.
export const writePrivately = async (path: string, text: string): Promise<void> => {
  await claimTalosFolder();
  const writing = `${path}.${process.pid}-${crypto.randomUUID()}.writing`;
  try {
    await writeFile(writing, text, { mode: CREDENTIALS_FILE_MODE, flag: "wx" });
    await rename(writing, path);
  } finally {
    await rm(writing, { force: true });
  }
};
