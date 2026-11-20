// What an example is, as pure functions: given what happened, its new state and
// what to do; given its state, what the screen shows. The kit runs the rest
// (the terminal, the session runner, recording and replay), so an example's own
// code is only this.
import type { Result, RunnerEvent } from "../../index";

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
