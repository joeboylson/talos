// Runs an example: live (real Claude), record (live, saved to its recordings/),
// or replay (a saved run played back, no Claude), chosen with MODE. This is the
// thin, impure part; everything the example decides is in its view.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { connectToSessions, type Result, type SessionsConnection } from "../../index";
import { readRecording, recordEvent, toInput, writeRecording, type RecordedLine } from "./recording";
import { fitScreen, frame } from "./screen";
import type { Action, ExampleView, Input } from "./view";
import { CTRL_C, SESSION_NAME } from "./view";

export { SESSION_NAME };

const REPLAY_STEP_MS = 120;

type Mode = "live" | "record" | "replay";
const readMode = (): Mode => {
  const mode = process.env.MODE || "live";
  if (mode !== "live" && mode !== "record" && mode !== "replay") throw new Error(`MODE must be live, record or replay, not "${mode}"`);
  return mode;
};

const draw = <State>(view: ExampleView<State>, state: State) => {
  const columns = process.stdout.columns || 80;
  const lines = fitScreen(view.render(state, columns), columns, process.stdout.rows || 40);
  process.stdout.write(frame(lines));
};

// A fresh run/ (the last run's is cleared), with its own copy of data/ in
// run/work, which is all Claude may work in.
export const prepareRun = (exampleFolder: string) => {
  const home = join(exampleFolder, "run");
  rmSync(home, { recursive: true, force: true });
  const work = join(home, "work");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // Links are copied as the files they point to: a link left as one would let
  // the session change data/ itself.
  cpSync(join(exampleFolder, "data"), work, { recursive: true, dereference: true });
  // Its own git repository, so Claude Code keeps the session runner's answers
  // (trust, CLAUDE.md imports) for this folder, not for the repo around it.
  Bun.spawnSync(["git", "init", "--quiet", work]);
  return { home, work };
};

// A run's folder, prepared fresh, unless another run of the example is using
// it: preparing would delete its runner's sockets and trust record from under it.
// The call to the session runner each action a view asks for makes.
export const callFor = (calls: SessionsConnection, action: Exclude<Action, { do: "quit" }>): Promise<Result> => {
  if (action.do === "send") return calls.send(SESSION_NAME, action.text);
  if (action.do === "ask") return calls.ask(SESSION_NAME, action.kind);
  return calls.answer(SESSION_NAME, action.outputId, action.choice);
};

export const claimRun = async (exampleFolder: string) => {
  const isInUse = await connectToSessions({ home: join(exampleFolder, "run"), runnerScript: "" }).isRunning();
  if (isInUse) throw new Error("another run of this example is going; wait for it to end");
  return prepareRun(exampleFolder);
};

// farewell runs once the session runner has stopped, with the run's folder, and
// gives back lines to print on the way out.
export const runExample = async <State>(exampleFolder: string, view: ExampleView<State>, farewell?: (home: string) => string[]) => {
  const mode = readMode();
  const recordingFile = join(exampleFolder, "recordings", "run.jsonl");
  let state = view.initial;
  const recorded: RecordedLine[] = [];
  const record = (line: RecordedLine) => mode === "record" && recorded.push(line);

  if (mode === "replay") {
    if (!existsSync(recordingFile)) throw new Error(`no recording yet: run with MODE=record first`);
    const inputs = [{ type: "started" } as Input, ...readRecording(readFileSync(recordingFile, "utf8")).map(toInput)];
    for (const input of inputs) {
      state = view.step(state, input).state;
      draw(view, state);
      await Bun.sleep(REPLAY_STEP_MS);
    }
    process.stdout.write("\r\n");
    return;
  }

  // Keys come in raw from a terminal; without one there's nothing to drive it.
  if (!process.stdin.isTTY) throw new Error("run an example in a terminal");
  const { home, work } = await claimRun(exampleFolder);
  process.env.EXAMPLE_PROCESS_ID = String(process.pid);
  const calls = connectToSessions({ home, runnerScript: join(exampleFolder, "runner.ts") });

  let stopping: Promise<void> | null = null;
  const stop = (code: number, error?: unknown) => {
    // Printed first: stopping ends the process.
    if (error !== undefined) console.error(error);
    stopping ??= (async () => {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      await calls.stopRunner().catch(() => {});
      // Only a run that ended well replaces the recording.
      if (mode === "record" && code === 0) writeRecording(recordingFile, recorded, home);
      const lines = [...(farewell?.(home) ?? []), `${home} has what this run made.`];
      process.stdout.write(`\r\n${lines.join("\r\n")}\r\n`);
      process.exit(code);
    })();
    return stopping;
  };
  ["SIGINT", "SIGTERM", "SIGHUP"].forEach((signal) => process.on(signal, () => void stop(0)));

  const run = async (action: Action) => {
    if (action.do === "quit") return stop(0);
    const result = await callFor(calls, action);
    record({ type: "result", action, result });
    dispatch({ type: "result", action, result });
  };

  // A view that throws stops the run like any other error, so the runner is
  // stopped and the error shown.
  function dispatch(input: Input) {
    try {
      const stepped = view.step(state, input);
      state = stepped.state;
      draw(view, state);
      stepped.actions.forEach((action) => void run(action).catch((error: unknown) => stop(1, error)));
    } catch (error) {
      void stop(1, error);
    }
  }

  function onKeys(chunk: Buffer) {
    const key = chunk.toString();
    if (key === CTRL_C) return void stop(0);
    record({ type: "key", key });
    dispatch({ type: "key", key });
  }

  await calls.ensureRunning();
  calls.follow((event) => {
    record(recordEvent(event));
    dispatch({ type: "event", event });
  });
  const started = await calls.start(SESSION_NAME, "work", work);
  if (!started.ok) throw new Error(started.reason);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", onKeys);
  process.stdout.on("resize", () => {
    draw(view, state);
  });
  dispatch({ type: "started" });
};
