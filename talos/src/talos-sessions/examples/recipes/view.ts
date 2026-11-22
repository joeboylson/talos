// recipes: a plain chat with a Claude Code session. No kinds at all: the module
// is also just a way to run and talk to a session, and watch it work.
import { mergeSessionEntries, type SessionEntry, type SessionSummary } from "../../index";
import { bold, dim, fit, lastCells, wrapText, yellow } from "../kit/screen";
import { CTRL_A, exampleSession, noActions, typeIntoDraft, type ExampleView } from "../kit/view";

const KEPT_ENTRIES = 500;

export type RecipesState = {
  session: SessionSummary["state"] | "starting" | "gone";
  entries: SessionEntry[];
  draft: string;
  notice: string;
};

const drawEntry = (entry: SessionEntry, width: number): string[] => {
  if (entry.kind === "prompt") return ["", ...wrapText(entry.text, width - 2).map((line, index) => bold(`${index === 0 ? "›" : " "} ${line}`))];
  if (entry.kind === "text") return wrapText(entry.text, width);
  if (entry.kind === "tool") return [dim(fit(`· ${entry.toolName} ${entry.summary}`, width))];
  return [dim("· (not shown)")];
};

export const recipesView: ExampleView<RecipesState> = {
  initial: { session: "starting", entries: [], draft: "", notice: "" },
  step: (state, input) => {
    if (input.type === "event") {
      const { event } = input;
      if (event.type === "sessions") {
        // Not listed once it has ended; before it starts, it isn't listed yet either.
        const session = exampleSession(event.sessions)?.state ?? (state.session === "starting" ? "starting" : "gone");
        return noActions({ ...state, session });
      }
      if (event.type === "session-entries") return noActions({ ...state, entries: mergeSessionEntries(state.entries, event.entries, KEPT_ENTRIES) });
      return noActions({ ...state, notice: event.message });
    }
    if (input.type === "result") {
      // A message that couldn't be sent goes back into the draft, so it isn't lost.
      const { action, result } = input;
      const draft = !result.ok && action.do === "send" && state.draft === "" ? action.text : state.draft;
      return noActions({ ...state, draft, notice: result.ok ? "" : result.reason });
    }
    if (input.type !== "key") return noActions(state);
    const { key } = input;
    if (key === CTRL_A) return { state, actions: [{ do: "attach" }] };
    const { draft, sent } = typeIntoDraft(state.draft, key);
    return { state: { ...state, draft }, actions: sent.map((text) => ({ do: "send" as const, text })) };
  },
  render: (state, columns) => {
    const width = Math.max(columns, 1);
    const mark = state.session === "working" ? yellow("◐ cooking") : state.session === "needs-you" ? yellow("⚠ needs you · ^A") : state.session === "starting" ? dim("○ starting") : state.session === "gone" ? dim("○ ended") : "● ready";
    return [
      `${bold("recipes")}  ${mark}`,
      ...state.entries.flatMap((entry) => drawEntry(entry, width)),
      "",
      ...(state.notice ? [yellow(fit(state.notice, width))] : []),
      `› ${lastCells(state.draft, width - 3)}▏`,
      dim("⏎ send · ^A watch the session · ^C quit"),
    ];
  },
};
