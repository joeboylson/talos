import { appendFile, mkdir, readdir, rm } from "node:fs/promises";
import { parseJsonOrNull } from "talos-shared";
import { CREDENTIALS_FILE_MODE, CREDENTIALS_FOLDER_MODE } from "../constants";
import { claimTalosFolder, writePrivately } from "../talos-folder";
import { LOOPS_FOLDER, historyFile, loopFile } from "./constants";
import type { Loop, LoopRun } from "./loop";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export const readLoopShape = (value: unknown): Loop | null => {
  if (!isRecord(value) || !isRecord(value.limit)) return null;
  const { sessionName, message, schedule, startedAtMs, limit } = value;
  if (typeof sessionName !== "string" || !isRecord(message) || typeof schedule !== "string" || !isNumber(startedAtMs)) return null;
  const readMessage = typeof message.text === "string" ? { text: message.text } : typeof message.file === "string" ? { file: message.file } : null;
  const readLimit = isNumber(limit.runs) ? { runs: limit.runs } : isNumber(limit.untilMs) ? { untilMs: limit.untilMs } : null;
  return readMessage && readLimit && { sessionName, message: readMessage, schedule, startedAtMs, limit: readLimit };
};

export const readRunShape = (value: unknown): LoopRun | null => {
  if (!isRecord(value) || !isNumber(value.atMs)) return null;
  const { atMs, outcome, reason, missedRuns } = value;
  if (outcome === "sent" || outcome === "ended") return { atMs, outcome };
  if (outcome !== "skipped") return null;
  if (reason === "busy" || reason === "unreadable-file") return { atMs, outcome, reason };
  return reason === "machine-off" && isNumber(missedRuns) ? { atMs, outcome, reason, missedRuns } : null;
};

const claimLoopsFolder = async (): Promise<void> => {
  await claimTalosFolder();
  await mkdir(LOOPS_FOLDER, { recursive: true, mode: CREDENTIALS_FOLDER_MODE });
};

// No file means no loop. A file talos can't read throws, so a broken loop
// doesn't quietly stop running.
export const readLoop = async (sessionName: string): Promise<Loop | null> => {
  const file = Bun.file(loopFile(sessionName));
  if (!(await file.exists())) return null;
  const loop = readLoopShape(parseJsonOrNull(await file.text()));
  if (!loop) throw new Error(`${loopFile(sessionName)} isn't a loop; fix or delete it`);
  return loop;
};

export const saveLoop = async (loop: Loop): Promise<void> => {
  await claimLoopsFolder();
  await writePrivately(loopFile(loop.sessionName), JSON.stringify(loop, null, 2));
};

export const readHistory = async (sessionName: string): Promise<LoopRun[]> => {
  const file = Bun.file(historyFile(sessionName));
  if (!(await file.exists())) return [];
  const lines = (await file.text()).split("\n").filter((line) => line.trim());
  const runs = lines.map((line) => readRunShape(parseJsonOrNull(line)));
  if (runs.some((run) => run === null)) throw new Error(`${historyFile(sessionName)} has a line that isn't a run; fix or delete it`);
  return runs as LoopRun[];
};

export const addToHistory = async (sessionName: string, runs: readonly LoopRun[]): Promise<void> => {
  if (runs.length === 0) return;
  await claimLoopsFolder();
  await appendFile(historyFile(sessionName), runs.map((run) => `${JSON.stringify(run)}\n`).join(""), { mode: CREDENTIALS_FILE_MODE });
};

export const removeLoop = async (sessionName: string): Promise<void> => {
  await Promise.all([rm(loopFile(sessionName), { force: true }), rm(historyFile(sessionName), { force: true })]);
};

export const loopSessionNames = async (): Promise<string[]> => {
  const names = await readdir(LOOPS_FOLDER).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length));
};

// All sessions end when the session runner stops, so their loops go too.
// Otherwise a new session with an old name would pick up the old loop.
export const removeAllLoops = (): Promise<void> => rm(LOOPS_FOLDER, { recursive: true, force: true });
