// Runs inside the session runner. Every check reads each loop file again, so
// an edit counts from the next run.
import type { Logger } from "talos-shared";
import type { SessionsConnection, SessionSummary } from "../talos-sessions";
import { LOOP_CHECK_MS } from "./constants";
import { addToHistory, loopSessionNames, readHistory, readLoop, removeAllLoops, removeLoop } from "./loop-files";
import { checkLoop, type LoopMessage, type LoopRun } from "./loop";

// Free means no turn running, no question open and no message waiting.
const isFree = (session: SessionSummary): boolean => session.state === "idle" && (session.waitingMessages ?? []).length === 0;

const describeRun = (sessionName: string, run: LoopRun): string | null => {
  if (run.outcome === "ended") return `loops: ${sessionName}'s loop reached its limit`;
  if (run.outcome === "skipped" && run.reason === "machine-off") return `loops: ${sessionName}'s loop missed ${run.missedRuns} run(s) while the machine was off`;
  return null;
};

// The text to send: the loop's own, or its file's as it is now. Null when the
// file can't give any.
const messageText = async (message: LoopMessage, log: Logger): Promise<string | null> => {
  if ("text" in message) return message.text;
  const text = await Bun.file(message.file).text().catch((error: unknown) => {
    log.warn(`loops: skipped a run: couldn't read ${message.file}: ${String(error)}`);
    return null;
  });
  if (text !== null && !text.trim()) log.warn(`loops: skipped a run: ${message.file} is empty`);
  return text?.trim() ? text : null;
};

const checkOneLoop = async (sessions: SessionsConnection, running: readonly SessionSummary[], sessionName: string, lastCheckMs: number, nowMs: number, log: Logger): Promise<void> => {
  const session = running.find((candidate) => candidate.sessionName === sessionName);
  if (!session) {
    log.event(`loops: ${sessionName} ended, so its loop did too`);
    return removeLoop(sessionName);
  }
  const loop = await readLoop(sessionName);
  if (!loop) return;
  const history = await readHistory(sessionName);
  const check = { loop, history, lastCheckMs, nowMs };
  const runs = checkLoop({ ...check, skipReason: isFree(session) ? null : "busy" });
  const isSending = runs.some((run) => run.outcome === "sent");
  const text = isSending ? await messageText(loop.message, log) : null;
  const isSent = text !== null && (await sessions.send(sessionName, text)).ok;
  // A file with nothing to send is an unreadable-file skip. A send the runner
  // refuses (the session got busy) is a busy skip.
  const skipReason = text === null ? "unreadable-file" : "busy";
  const recorded = isSending && !isSent ? checkLoop({ ...check, skipReason }) : runs;
  await addToHistory(sessionName, recorded);
  recorded.forEach((run) => {
    const line = describeRun(sessionName, run);
    if (line && run.outcome === "skipped") log.warn(line);
    else if (line) log.event(line);
  });
};

// A failing loop is logged, not thrown, so it can't stop the other loops or
// the session runner.
export const checkLoops = async (sessions: SessionsConnection, lastCheckMs: number, nowMs: number, log: Logger): Promise<void> => {
  try {
    const running = await sessions.sessions();
    const names = await loopSessionNames();
    const results = await Promise.allSettled(names.map((sessionName) => checkOneLoop(sessions, running, sessionName, lastCheckMs, nowMs, log)));
    results.forEach((result) => {
      if (result.status === "rejected") log.warn(`loops: ${String(result.reason)}`);
    });
  } catch (error) {
    log.warn(`loops: couldn't check the loops: ${String(error)}`);
  }
};

export const runLoops = async (sessions: SessionsConnection, log: Logger): Promise<void> => {
  await removeAllLoops();
  // Each check starts after the last one ends, so a slow send can't go out
  // twice. The last check's time only needs to live in memory, because the
  // loops end with the session runner. After the machine sleeps, the gap since
  // that time is how checkLoop finds the runs it missed.
  const checkThenWait = async (lastCheckMs: number): Promise<void> => {
    const nowMs = Date.now();
    await checkLoops(sessions, lastCheckMs, nowMs, log);
    setTimeout(() => void checkThenWait(nowMs), LOOP_CHECK_MS);
  };
  const startedMs = Date.now();
  setTimeout(() => void checkThenWait(startedMs), LOOP_CHECK_MS);
};
