// A recording: what an example received and did in one live run, one JSON line
// each. Events are saved as the session runner sent them and read back with the
// module's own reader, so a change to what it sends shows up as a failed replay.
// Ids, times and folder paths become stable placeholders as it's saved, so a
// re-recording's diff shows only what changed.
import { encodeRunnerEvent, parseRunnerEvent, type Result, type RunnerEvent } from "../../index";
import type { Action, ExampleView, Input } from "./view";

export type RecordedLine =
  | { type: "event"; line: string }
  | { type: "key"; key: string }
  | { type: "result"; action: Action; result: Result };

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
const TIME = /"(atMs|askedAtMs)":\d+/g;

// Same id, same placeholder, across the whole recording.
export const placeholdersFor = (runFolder: string) => {
  const ids = new Map<string, string>();
  return (text: string): string =>
    text
      .replaceAll(runFolder, "<run>")
      .replace(UUID, (id) => ids.get(id) ?? (ids.set(id, `id-${ids.size + 1}`), ids.get(id)!))
      .replace(TIME, (_match, field: string) => `"${field}":0`);
};

export const recordEvent = (event: RunnerEvent): RecordedLine => ({ type: "event", line: encodeRunnerEvent(event).trimEnd() });

export const readRecording = (text: string): RecordedLine[] =>
  text
    .split("\n")
    .filter((line) => line.trim())
    .map((line, index) => {
      const value: unknown = JSON.parse(line);
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
  if (!event) throw new Error(`recording line ${index + 1} isn't an event the module reads: re-record this`);
  return { type: "event", event };
};

// Plays a recording through a view, with no session runner and no Claude.
// Gives back every state and every action, for tests to check.
export const replay = <State>(view: ExampleView<State>, recording: readonly RecordedLine[]) =>
  [{ type: "started" } as Input, ...recording.map(toInput)].reduce(
    (played, input) => {
      const { state, actions } = view.step(played.state, input);
      return { state, states: [...played.states, state], actions: [...played.actions, ...actions] };
    },
    { state: view.initial, states: [view.initial], actions: [] as Action[] },
  );

// The lines as saved: an event's own line gets its placeholders before it's
// wrapped, since inside the wrapper its quotes are escaped.
export const saveRecording = (recorded: readonly RecordedLine[], runFolder: string): string => {
  const placeholders = placeholdersFor(runFolder);
  return `${recorded.map((line) => (line.type === "event" ? JSON.stringify({ type: "event", line: placeholders(line.line) }) : placeholders(JSON.stringify(line)))).join("\n")}\n`;
};
