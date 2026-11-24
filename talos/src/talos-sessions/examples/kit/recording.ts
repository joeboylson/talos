// A recording: what an example received and did in one live run, one JSON line
// each. Events are saved as the session runner sent them and read back with the
// module's own reader, so a change to what it sends shows up as a failed replay.
// Ids, times and folder paths become stable placeholders as it's saved, so a
// re-recording's diff shows only what changed.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { encodeRunnerEvent, parseRunnerEvent, type Result, type RunnerEvent } from "../../index";
import type { Action, ExampleView, Input } from "./view";

export type RecordedLine =
  | { type: "event"; line: string }
  | { type: "key"; key: string }
  | { type: "result"; action: Action; result: Result };

// The runner's ids, and Claude Code's tool ids.
const ID = /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|toolu_[A-Za-z0-9]+)\b/g;
const TIME = /"(atMs|askedAtMs)":\d+/g;

// Same id, same placeholder, across the whole recording.
// The run folder only as a whole path, so the run.ts next to it stays itself.
export const placeholdersFor = (runFolder: string) => {
  const ids = new Map<string, string>();
  const runFolderPattern = new RegExp(`${runFolder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[/"\\\\]|$)`, "g");
  return (text: string): string =>
    text
      .replace(runFolderPattern, "<run>")
      .replace(ID, (id) => ids.get(id) ?? (ids.set(id, `id-${ids.size + 1}`), ids.get(id)!))
      .replace(TIME, (_match, field: string) => `"${field}":0`);
};

export const recordEvent = (event: RunnerEvent): RecordedLine => ({ type: "event", line: encodeRunnerEvent(event).trimEnd() });

export const readRecording = (text: string): RecordedLine[] =>
  text
    .split("\n")
    .filter((line) => line.trim())
    .map((line, index) => {
      const value: unknown = (() => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })();
      const type = typeof value === "object" && value !== null ? Reflect.get(value, "type") : undefined;
      if (type !== "event" && type !== "key" && type !== "result") throw new Error(`recording line ${index + 1} is unreadable: re-record this`);
      return value as RecordedLine;
    });

// A recorded line as the view's input. An event the module can't read fails
// the replay: the module's events changed, so the recording needs re-recording.
export const toInput = (recorded: RecordedLine, index: number): Input => {
  if (recorded.type === "key") return { type: "key", key: recorded.key };
  if (recorded.type === "result") return { type: "result", action: recorded.action, result: recorded.result };
  const event = parseRunnerEvent(recorded.line);
  // The module's reader drops what it doesn't know (a state, a field) rather
  // than failing, so the event read must say all the recorded line said.
  const isWhole = event !== null && Bun.deepEquals(JSON.parse(encodeRunnerEvent(event)), JSON.parse(recorded.line));
  if (!isWhole) throw new Error(`recording line ${index + 1} isn't an event the module reads: re-record this`);
  return { type: "event", event };
};

// Plays a recording through a view, with no session runner and no Claude.
// Gives back every state and every action, for tests to check. A recorded
// result is for an action still waiting for one (the first the same, since
// live results come back in the order they finish): if the view asked for no
// such action, it no longer does what was recorded.
export const replay = <State>(view: ExampleView<State>, recording: readonly RecordedLine[]) => {
  const played = [{ type: "started" } as Input, ...recording.map(toInput)].reduce(
    (played, input) => {
      const resultFor = input.type === "result" ? played.waiting.findIndex((waiting) => Bun.deepEquals(waiting, input.action)) : -1;
      if (input.type === "result" && resultFor === -1) {
        throw new Error(`the view did ${JSON.stringify(played.waiting)}, but the recording has a result for ${JSON.stringify(input.action)}: re-record this`);
      }
      const stillWaiting = played.waiting.filter((_waiting, index) => index !== resultFor);
      const { state, actions } = view.step(played.state, input);
      const waitingNow = [...stillWaiting, ...actions.filter(({ do: what }) => what !== "quit")];
      return { state, states: [...played.states, state], actions: [...played.actions, ...actions], waiting: waitingNow };
    },
    { state: view.initial, states: [view.initial], actions: [] as Action[], waiting: [] as Action[] },
  );
  return { state: played.state, states: played.states, actions: played.actions };
};

// Saved whole or not at all: a new file swapped in, so a crash can't leave half.
export const writeRecording = (file: string, recorded: readonly RecordedLine[], runFolder: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, saveRecording(recorded, runFolder));
  renameSync(`${file}.tmp`, file);
};

// The lines as saved: an event's own line gets its placeholders before it's
// wrapped, since inside the wrapper its quotes are escaped.
export const saveRecording = (recorded: readonly RecordedLine[], runFolder: string): string => {
  const placeholders = placeholdersFor(runFolder);
  return `${recorded.map((line) => (line.type === "event" ? JSON.stringify({ type: "event", line: placeholders(line.line) }) : placeholders(JSON.stringify(line)))).join("\n")}\n`;
};
