import { join } from "node:path";
import { TALOS_FOLDER } from "../constants";

// Every loop needs a limit, and none can be larger than these (docs/TASKS.md).
// lateMs: a run due longer ago than this was missed while the machine was off,
// not just waiting for the next check.
export const LOOP_LIMITS = { maxRuns: 999, maxDays: 7, lateMs: 60_000 } as const;

// How often the session runner checks its loops; well under lateMs.
export const LOOP_CHECK_MS = 10_000;

// One file per loop, written only by the talos command, and one history per
// loop, added to only by the session runner, so neither overwrites the other.
export const LOOPS_FOLDER = join(TALOS_FOLDER, "loops");
export const loopFile = (sessionName: string): string => join(LOOPS_FOLDER, `${sessionName}.json`);
export const historyFile = (sessionName: string): string => join(LOOPS_FOLDER, `${sessionName}.history.jsonl`);
