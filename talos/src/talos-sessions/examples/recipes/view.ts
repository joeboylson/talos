// recipes: a plain chat with a Claude Code session. No kinds at all: the module
// is also just a way to run and talk to a session, and watch it work.
import { mergeSessionEntries, type SessionEntry, type SessionSummary } from "../../index";
import { bold, dim, fit, yellow } from "../kit/screen";
import { BACKSPACE, CTRL_A, ENTER, noActions, type ExampleView } from "../kit/view";

const KEPT_ENTRIES = 500;

export type RecipesState = {
  session: SessionSummary["state"] | "starting";
  entries: SessionEntry[];
  draft: string;
  notice: string;
};

const wrapText = (text: string, width: number): string[] =>
  text.split("\n").flatMap((paragraph) =>
    paragraph.split(" ").reduce<string[]>((lines, word) => {
      const last = lines.at(-1);
      if (last !== undefined && (last ? `${last} ${word}` : word).length <= width) return [...lines.slice(0, -1), last ? `${last} ${word}` : word];
      return [...lines, word];
    }, []),
  );

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
      if (event.type === "sessions") return noActions({ ...state, session: event.sessions[0]?.state ?? state.session });
      if (event.type === "session-entries") return noActions({ ...state, entries: mergeSessionEntries(state.entries, event.entries, KEPT_ENTRIES) });
      return noActions({ ...state, notice: event.message });
    }
    if (input.type === "result") return noActions({ ...state, notice: input.result.ok ? "" : input.result.reason });
    if (input.type !== "key") return noActions(state);
    const { key } = input;
    if (key === CTRL_A) return { state, actions: [{ do: "attach" }] };
    if (key === ENTER) {
      const text = state.draft.trim();
      return text ? { state: { ...state, draft: "" }, actions: [{ do: "send", text }] } : noActions(state);
    }
    if (key === BACKSPACE) return noActions({ ...state, draft: state.draft.slice(0, -1) });
    const typed = key.replace(/[\x00-\x1f\x7f]/g, "");
    return noActions(typed ? { ...state, draft: state.draft + typed } : state);
  },
  render: (state, columns) => {
    const width = Math.max(columns, 40);
    const mark = state.session === "working" ? yellow("◐ cooking") : state.session === "needs-you" ? yellow("⚠ needs you · ^A") : state.session === "starting" ? dim("○ starting") : "● ready";
    return [
      `${bold("recipes")}  ${mark}`,
      ...state.entries.flatMap((entry) => drawEntry(entry, width)),
      "",
      ...(state.notice ? [yellow(fit(state.notice, width))] : []),
      `› ${state.draft}▏`,
      dim("⏎ send · ^A watch the session · ^C quit"),
    ];
  },
};
