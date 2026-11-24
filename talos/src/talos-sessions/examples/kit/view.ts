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

// Ctrl-C and the other keys the views read, as raw-mode keys.
export const CTRL_C = "\x03";
export const ENTER = "\r";
export const BACKSPACE = "\x7f";

// The one session an example runs, by name.
export const SESSION_NAME = "example";
export const exampleSession = (sessions: readonly SessionSummary[]): SessionSummary | undefined =>
  sessions.find(({ sessionName }) => sessionName === SESSION_NAME);

// What the person types into a draft, as the terminal sends it: a key, or a
// paste in one piece. Escape sequences (arrow keys) type nothing, line breaks
// and tabs become spaces, and each Enter sends what's typed so far.
// CSI keys (arrows, Home, mouse reports), SS3 keys (F1–F4, arrows in
// application mode: Esc O and a letter), and Alt-letters.
const ESCAPE_SEQUENCE = /\x1b\[[0-9;?<]*[ -\/]*[@-~]|\x1bO.|\x1b./g;
// The last character as a person sees one (an emoji with its skin tone, a
// letter with its accent), never half of one.
const graphemes = new Intl.Segmenter();
const withoutLastCharacter = (text: string): string =>
  [...graphemes.segment(text)].slice(0, -1).map(({ segment }) => segment).join("");

// Each Backspace (or Ctrl-H) in the keys takes one character, wherever it is:
// a busy moment or a held key sends several keys in one piece.
const BACKSPACE_KEYS = /[\x7f\x08]/;
export const typeIntoDraft = (draft: string, key: string): { draft: string; sent: string[] } =>
  key.split(BACKSPACE_KEYS).reduce(
    (typed, piece, index) => {
      const next = typeText(index === 0 ? typed.draft : withoutLastCharacter(typed.draft), piece);
      return { draft: next.draft, sent: [...typed.sent, ...next.sent] };
    },
    { draft, sent: [] as string[] },
  );

const typeText = (draft: string, key: string): { draft: string; sent: string[] } => {
  const parts = key
    .replace(ESCAPE_SEQUENCE, "")
    .replace(/\r\n/g, "\r")
    .split("\r")
    .map((part) => part.replace(/[\n\t]/g, " ").replace(/[\x00-\x1f\x7f]/g, ""));
  const lines = [draft + parts[0], ...parts.slice(1)];
  return { draft: lines.at(-1)!, sent: lines.slice(0, -1).map((line) => line.trim()).filter(Boolean) };
};
