// What an example's live check shares: a real run of the example with no
// screen, driven by scripted keys through the example's own view, so the check
// sees what a person would. With MODE=record it saves the run as the example's
// recording, the same way a recorded live run does.
import { join } from "node:path";
import { connectToSessions } from "../../index";
import { recordEvent, writeRecording, type RecordedLine } from "./recording";
import { SESSION_NAME, callFor, claimRun } from "./run-example";
import type { Action, ExampleView, Input } from "./view";

export const startLiveCheck = async <State>(exampleFolder: string, view: ExampleView<State>) => {
  const { home, work } = await claimRun(exampleFolder);
  process.env.EXAMPLE_PROCESS_ID = String(process.pid);
  const calls = connectToSessions({ home, runnerScript: join(exampleFolder, "runner.ts") });
  const recorded: RecordedLine[] = [];
  let state = view.initial;

  const run = async (action: Action): Promise<void> => {
    if (action.do === "attach" || action.do === "quit") return;
    const result = await callFor(calls, action);
    recorded.push({ type: "result", action, result });
    dispatch({ type: "result", action, result });
  };
  const dispatch = (input: Input) => {
    const stepped = view.step(state, input);
    state = stepped.state;
    // A call made after the check has finished (its runner stopped) fails; that's
    // not the check failing.
    stepped.actions.forEach((action) => void run(action).catch(() => {}));
  };

  await calls.ensureRunning();
  calls.follow((event) => {
    recorded.push(recordEvent(event));
    dispatch({ type: "event", event });
  });
  const started = await calls.start(SESSION_NAME, "work", work);
  if (!started.ok) throw new Error(started.reason);
  dispatch({ type: "started" });

  return {
    work,
    state: () => state,
    type: (key: string) => {
      recorded.push({ type: "key", key });
      dispatch({ type: "key", key });
    },
    waitFor: async (isDone: (current: State) => boolean, what: string, ms = 240_000) => {
      const giveUpAt = Date.now() + ms;
      while (!isDone(state)) {
        if (Date.now() > giveUpAt) throw new Error(`timed out waiting for ${what}`);
        await Bun.sleep(500);
      }
    },
    finish: async () => {
      await calls.stopRunner().catch(() => {});
      if (process.env.MODE === "record") writeRecording(join(exampleFolder, "recordings", "run.jsonl"), recorded, home);
    },
  };
};

// Prints each check's outcome, and fails the run if any failed.
export const checker = () => {
  let failed = 0;
  return {
    check: (name: string, passed: boolean, detail = "") => {
      if (!passed) failed += 1;
      console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
    },
    done: () => process.exit(failed > 0 ? 1 : 0),
  };
};
