// The one tested Claude Code that runs every session: a copy in the home that
// its own updater can't touch (it deletes old versions from its own folder).
// A hard link where it can, since the binary is a few hundred MB; the link
// keeps the file even once the installer deletes its own name for it.
import { copyFileSync, existsSync, linkSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

const versionOf = (command: string): string | null => {
  const ran = Bun.spawnSync([command, "--version"], { stdout: "pipe", stderr: "ignore" });
  return ran.exitCode === 0 ? ran.stdout.toString().trim().split(/\s/)[0] ?? null : null;
};

const realPathOrNull = (path: string | null): string | null => {
  if (!path || !existsSync(path)) return null;
  return realpathSync(path);
};

// The pinned copy's path, made from the first candidate that is the pinned
// version; null if none is (the caller falls back to `claude` on the path).
export const pinClaudeCode = (pinnedFolder: string, version: string, candidates: readonly (string | null)[]): string | null => {
  const pinned = join(pinnedFolder, version, "claude");
  if (existsSync(pinned)) return pinned;
  const source = candidates.map(realPathOrNull).find((path) => path !== null && versionOf(path) === version);
  if (!source) return null;
  mkdirSync(join(pinnedFolder, version), { recursive: true, mode: 0o700 });
  // Copied only when linking fails (another disk). The mode stays as it is:
  // a link shares the installer's file.
  try {
    linkSync(source, pinned);
  } catch {
    copyFileSync(source, pinned);
  }
  return pinned;
};
