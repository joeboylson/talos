// Attach's loop menu (Ctrl+P, then Loop): the same loop the talos command
// starts and changes, by questions instead of flags. It saves the loop file,
// and the session runner picks it up at its next check.
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { note } from "@clack/prompts";
import { askChoice, askText, askYesNo } from "../ask";
import { resolveFolderPath } from "../folder-commands";
import { parseCron } from "./cron";
import { readHistory, readLoop, removeLoop, saveLoop } from "./loop-files";
import { loopProblem, type Loop, type LoopLimit, type LoopMessage } from "./loop";
import { formatTime, loopChangedLine, loopDetails, parseUntil } from "./loop-text";

const DEFAULT_RUNS = "24";
const WHOLE_NUMBER = /^\d+$/;

const fullPathOf = (typed: string): string => resolveFolderPath(typed.trim(), process.cwd(), homedir());
const isFileThere = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

// Typed text, or a file read again before every run.
const askMessage = async (current: LoopMessage | null): Promise<LoopMessage | null> => {
  const kind = await askChoice("Message", [
    { value: "text" as const, label: "Text" },
    { value: "file" as const, label: "File", hint: "read before every run" },
  ]);
  if (kind === "text") {
    const text = await askText("Text", current && "text" in current ? current.text : "", (typed) => (typed.trim() ? null : "type the message to send"));
    return text === null ? null : { text };
  }
  if (kind !== "file") return null;
  const typedFile = await askText("File", current && "file" in current ? current.file : "", (typed) =>
    isFileThere(fullPathOf(typed)) ? null : `there's no file at ${fullPathOf(typed)}`,
  );
  return typedFile === null ? null : { file: fullPathOf(typedFile) };
};
const askSchedule = (initial: string) =>
  askText("Schedule (cron)", initial, (typed) => (parseCron(typed) ? null : 'cron\'s five fields, like "0 * * * *" for every hour'));

// problemFor checks a limit against the rest of the loop, such as an end more
// than 7 days after its start.
const askLimit = async (current: LoopLimit | null, problemFor: (limit: LoopLimit) => string | null): Promise<LoopLimit | null> => {
  const kind = await askChoice("Limit", [
    { value: "runs" as const, label: "Runs", hint: "999 at most" },
    { value: "until" as const, label: "Until", hint: "7 days at most" },
  ]);
  if (kind === "runs") {
    const initial = current && "runs" in current ? String(current.runs) : DEFAULT_RUNS;
    const typed = await askText("Runs", initial, (text) => (WHOLE_NUMBER.test(text) ? problemFor({ runs: Number(text) }) : "a whole number"));
    return typed === null ? null : { runs: Number(typed) };
  }
  if (kind !== "until") return null;
  const initial = current && "untilMs" in current ? formatTime(current.untilMs) : "";
  const typed = await askText("Until", initial, (text) => {
    const untilMs = parseUntil(text);
    return untilMs === null ? "a date like 2026-11-30, or 2026-11-30 09:00" : problemFor({ untilMs });
  });
  return typed === null ? null : { untilMs: parseUntil(typed)! };
};

const startFromMenu = async (sessionName: string): Promise<Loop | null> => {
  const message = await askMessage(null);
  if (message === null) return null;
  const schedule = await askSchedule("0 * * * *");
  if (schedule === null) return null;
  const startedAtMs = Date.now();
  const limit = await askLimit(null, (candidate) => loopProblem({ sessionName, message, schedule, limit: candidate, startedAtMs }));
  return limit && { sessionName, message, schedule, limit, startedAtMs };
};

const CHANGES = ["message", "schedule", "limit", "restart", "stop"] as const;
type Change = (typeof CHANGES)[number];

// The questions a change asks, passed in so a test can answer them.
export type LoopQuestions = {
  askMessage: typeof askMessage;
  askSchedule: typeof askSchedule;
  askLimit: typeof askLimit;
};
const ASKED_IN_TERMINAL: LoopQuestions = { askMessage, askSchedule, askLimit };

// The loop after the change asked for, or null when the person backed out.
export const changeFromMenu = async (loop: Loop, change: Exclude<Change, "stop">, nowMs: number, questions: LoopQuestions = ASKED_IN_TERMINAL): Promise<Loop | null> => {
  if (change === "message") {
    const message = await questions.askMessage(loop.message);
    return message === null ? null : { ...loop, message };
  }
  if (change === "schedule") {
    const schedule = await questions.askSchedule(loop.schedule);
    return schedule === null ? null : { ...loop, schedule };
  }
  const restarted = change === "restart" ? { ...loop, startedAtMs: nowMs } : loop;
  // A restart keeps its limit unless that's no longer allowed, like an end that's passed.
  if (change === "restart" && !loopProblem(restarted)) return restarted;
  const limit = await questions.askLimit(loop.limit, (candidate) => loopProblem({ ...restarted, limit: candidate }));
  return limit && { ...restarted, limit };
};

// With a loop: show it, then ask what to change. Without one: start one. The
// result is the loop to save, a line to show, or null for nothing.
const loopFromMenu = async (sessionName: string): Promise<Loop | string | null> => {
  const loop = await readLoop(sessionName);
  if (!loop) return startFromMenu(sessionName);
  note(loopDetails(loop, await readHistory(sessionName), Date.now(), true), "Loop");
  const change = await askChoice("Change", CHANGES.map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) })));
  if (change === null) return null;
  if (change !== "stop") return changeFromMenu(loop, change, Date.now());
  if (!(await askYesNo(`Stop ${sessionName}'s loop?`, false))) return null;
  await removeLoop(sessionName);
  return `stopped ${sessionName}'s loop`;
};

// The line to show after the menu closes, or null when nothing changed.
export const openLoopMenu = async (sessionName: string): Promise<string | null> => {
  const result = await loopFromMenu(sessionName);
  if (result === null || typeof result === "string") return result;
  // The same check the talos command makes, such as an end that's already passed.
  const problem = loopProblem(result);
  if (problem) return problem;
  await saveLoop(result);
  return loopChangedLine(result, await readHistory(sessionName), Date.now());
};
