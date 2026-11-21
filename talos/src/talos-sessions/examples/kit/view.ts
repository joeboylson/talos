// What an example is, as pure functions: given what happened, its new state and
// what to do; given its state, what the screen shows. The kit runs the rest
// (the terminal, the session runner, recording and replay), so an example's own
// code is only this.
import type { Result, RunnerEvent, SessionSummary } from "../../index";

// What an example can ask the kit to do. Each call's result comes back as an
// input, so the view decides what a refusal means.
export type Action =
  | { do: "send"; text: string }
  | { do: "ask"; kind: string }
  | { do: "answer"; outputId: string; choice: number }
  | { do: "attach" }
  | { do: "quit" };

export type Input =
  | { type: "started" }
  | { type: "event"; event: RunnerEvent }
  | { type: "key"; key: string }
  | { type: "result"; action: Action; result: Result };

export type ExampleView<State> = {
  initial: State;
  step: (state: State, input: Input) => { state: State; actions: Action[] };
  // The screen, one string per line, for a terminal this wide.
  render: (state: State, columns: number) => string[];
};

export const noActions = <State>(state: State): { state: State; actions: Action[] } => ({ state, actions: [] });

// Ctrl-C and Ctrl-A, as raw-mode keys.
export const CTRL_C = "\x03";
export const CTRL_A = "\x01";
export const ENTER = "\r";
export const BACKSPACE = "\x7f";

// The one session an example runs, by name.
export const SESSION_NAME = "example";
export const exampleSession = (sessions: readonly SessionSummary[]): SessionSummary | undefined =>
  sessions.find(({ sessionName }) => sessionName === SESSION_NAME);

// What the person types into a draft, as the terminal sends it: a key, or a
// paste in one piece. Escape sequences (arrow keys) type nothing, line breaks
// and tabs become spaces, and each Enter sends what's typed so far.
const ESCAPE_SEQUENCE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b./g;
export const typeIntoDraft = (draft: string, key: string): { draft: string; sent: string[] } => {
  if (key === BACKSPACE) return { draft: draft.slice(0, -1), sent: [] };
  const parts = key
    .replace(ESCAPE_SEQUENCE, "")
    .replace(/\r\n/g, "\r")
    .split("\r")
    .map((part) => part.replace(/[\n\t]/g, " ").replace(/[\x00-\x1f\x7f]/g, ""));
  const lines = [draft + parts[0], ...parts.slice(1)];
  return { draft: lines.at(-1)!, sent: lines.slice(0, -1).map((line) => line.trim()).filter(Boolean) };
};
