// `talos sessions <session> loop ...`: the talos command writes a loop's file;
// the session runner reads it at its next check (loop-runner.ts).
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { cliError, formatTable, usageError, type Flags } from "../cli";
import { resolveFolderPath } from "../folder-commands";
import type { LoopCommand } from "../commands";
import { isIdentifierName } from "../talos-sessions";
import { readHistory, readLoop, removeLoop, saveLoop } from "./loop-files";
import { hasLoopEnded, loopProblem, nextRunMs, sentRunCount, type Loop, type LoopLimit, type LoopMessage } from "./loop";
import { describeOutcome, formatTime, loopChangedLine, loopDetails, parseUntil } from "./loop-text";

const SHOWN_HISTORY_RUNS = 10;
const START_EXAMPLE = 'talos sessions <session> loop "<text>"|-f <file> --cron "0 * * * *" --runs 24';

export const limitFromFlags = (flags: Pick<Flags, "runs" | "until">): LoopLimit | null => {
  if (flags.runs !== undefined && flags.until !== undefined) throw usageError("give a loop --runs or --until, not both");
  if (flags.runs !== undefined) {
    if (!/^\d+$/.test(flags.runs)) throw usageError(`--runs needs a whole number, not "${flags.runs}"`);
    return { runs: Number(flags.runs) };
  }
  if (flags.until === undefined) return null;
  const untilMs = parseUntil(flags.until);
  if (untilMs === null) throw usageError(`--until needs a date like 2026-11-30 or 2026-11-30T09:00, not "${flags.until}"`);
  return { untilMs };
};

// The message typed, or the file -f names, as its full path. The file must be
// there now; it's read again before every run.
const messageFromInput = async (text: string | null, typedFile: string | undefined): Promise<LoopMessage | null> => {
  if (text !== null && typedFile !== undefined) throw usageError("give a loop a message or -f <file>, not both");
  if (typedFile === undefined) return text === null ? null : { text };
  const file = resolveFolderPath(typedFile, process.cwd(), homedir());
  const isFile = await stat(file).then((info) => info.isFile(), () => false);
  if (!isFile) throw cliError(`${file} isn't a file`);
  return { file };
};

const checkedLoop = (loop: Loop, fix?: string): Loop => {
  const problem = loopProblem(loop);
  if (problem) throw cliError(problem, fix);
  return loop;
};

const loopOrFail = async (sessionName: string): Promise<Loop> => {
  const loop = await readLoop(sessionName);
  if (!loop) throw cliError(`${sessionName} has no loop`, START_EXAMPLE.replace("<session>", sessionName));
  return loop;
};

const sayNextRun = async (loop: Loop): Promise<void> => {
  const history = await readHistory(loop.sessionName);
  const restartHint = hasLoopEnded(loop, history) ? `; run talos sessions ${loop.sessionName} loop restart` : "";
  console.log(`${loopChangedLine(loop, history, Date.now())}${restartHint}`);
};

const startLoop = async (sessionName: string, text: string | null, flags: Flags): Promise<void> => {
  if (await readLoop(sessionName)) throw cliError(`${sessionName} already has a loop`, `talos sessions ${sessionName} loop edit`);
  const message = await messageFromInput(text, flags.file);
  const limit = limitFromFlags(flags);
  if (message === null) throw usageError('a loop needs a message: "<text>" or -f <file>', START_EXAMPLE);
  if (flags.cron === undefined || limit === null) throw usageError("a loop needs --cron and a limit (--runs or --until)", START_EXAMPLE);
  const loop = checkedLoop({ sessionName, message, schedule: flags.cron, limit, startedAtMs: Date.now() });
  await saveLoop(loop);
  await sayNextRun(loop);
};

const showLoop = async (sessionName: string, flags: Flags): Promise<void> => {
  const loop = await loopOrFail(sessionName);
  const history = await readHistory(sessionName);
  const nowMs = Date.now();
  const summary = { ...loop, sentRuns: sentRunCount(loop, history), hasEnded: hasLoopEnded(loop, history), nextRunMs: nextRunMs(loop, history, nowMs) };
  if (flags.json) return console.log(JSON.stringify({ ...summary, history }, null, 2));
  const isTerminal = process.stdout.isTTY === true;
  const recentRuns = history.slice(-SHOWN_HISTORY_RUNS).map((run) => [formatTime(run.atMs), describeOutcome(run)]);
  console.log(loopDetails(loop, history, nowMs, isTerminal));
  if (recentRuns.length > 0) console.log(`${isTerminal ? "\n" : ""}${formatTable(["run", "outcome"], recentRuns, isTerminal)}`);
};

const editLoop = async (sessionName: string, text: string | null, flags: Flags): Promise<void> => {
  const loop = await loopOrFail(sessionName);
  const message = await messageFromInput(text, flags.file);
  const limit = limitFromFlags(flags);
  if (message === null && flags.cron === undefined && limit === null) {
    throw usageError("there's nothing to change", `talos sessions ${sessionName} loop edit "<text>"|-f <file> --cron "<schedule>"`);
  }
  const edited = checkedLoop({ ...loop, ...(message && { message }), ...(flags.cron !== undefined && { schedule: flags.cron }), ...(limit && { limit }) });
  await saveLoop(edited);
  await sayNextRun(edited);
};

const restartLoop = async (sessionName: string, flags: Flags): Promise<void> => {
  const loop = await loopOrFail(sessionName);
  const limit = limitFromFlags(flags) ?? loop.limit;
  const restarted = checkedLoop({ ...loop, limit, startedAtMs: Date.now() }, `talos sessions ${sessionName} loop restart --until <date>`);
  await saveLoop(restarted);
  await sayNextRun(restarted);
};

const stopLoop = async (sessionName: string): Promise<void> => {
  await loopOrFail(sessionName);
  await removeLoop(sessionName);
  console.log(`stopped ${sessionName}'s loop`);
};

// Starting, editing and restarting a loop need its session running. Showing
// and stopping one don't.
export const runLoopCommand = async (command: LoopCommand, flags: Flags, isSessionRunning: () => Promise<boolean>): Promise<void> => {
  const { sessionName } = command;
  // The name becomes a file name, so a path like ../credentials must not get through.
  if (!isIdentifierName(sessionName)) throw cliError(`there's no session ${sessionName}`, "talos sessions");
  // `loop -f <file> --cron ...` has no words after loop, so its flags make it a start.
  const isStartByFlags = flags.file !== undefined || flags.cron !== undefined || flags.runs !== undefined || flags.until !== undefined;
  if (command.name === "sessions-loop-show" && !isStartByFlags) return showLoop(sessionName, flags);
  if (command.name === "sessions-loop-stop") return stopLoop(sessionName);
  if (!(await isSessionRunning())) throw cliError(`there's no session ${sessionName}`, "talos sessions");
  if (command.name === "sessions-loop-show") return startLoop(sessionName, null, flags);
  if (command.name === "sessions-loop-start") return startLoop(sessionName, command.message, flags);
  if (command.name === "sessions-loop-edit") return editLoop(sessionName, command.message, flags);
  return restartLoop(sessionName, flags);
};
