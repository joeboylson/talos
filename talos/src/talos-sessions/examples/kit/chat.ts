// What a chat example (explorer, recipes) shares: following the one session
// and its conversation, a draft to type into, and the lines that draw them.
// Each example adds only its own: its keys, its outputs, its words.
import { mergeSessionEntries, type SessionEntry, type SessionSummary } from "../../index";
import { bold, dim, fit, lastCells, wrapText, yellow } from "./screen";
import { CTRL_A, exampleSession, noActions, typeIntoDraft, type Action, type Input } from "./view";

const KEPT_ENTRIES = 500;

export type ChatState = {
  session: SessionSummary["state"] | "starting" | "gone";
  entries: SessionEntry[];
  draft: string;
  notice: string;
};
export const CHAT_START: ChatState = { session: "starting", entries: [], draft: "", notice: "" };

export const chatStep = <State extends ChatState>(state: State, input: Input): { state: State; actions: Action[] } => {
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
  if (input.key === CTRL_A) return { state, actions: [{ do: "attach" }] };
  const { draft, sent } = typeIntoDraft(state.draft, input.key);
  return { state: { ...state, draft }, actions: sent.map((text) => ({ do: "send" as const, text })) };
};

// drawOutput: how the example draws its own kinds' outputs.
export const drawChatEntry = (entry: SessionEntry, width: number, drawOutput?: (entry: Extract<SessionEntry, { kind: "output" }>) => string[]): string[] => {
  if (entry.kind === "prompt") return ["", ...wrapText(entry.text, width - 2).map((line, index) => bold(`${index === 0 ? "›" : " "} ${line}`))];
  if (entry.kind === "text") return wrapText(entry.text, width);
  if (entry.kind === "tool") return [dim(fit(`· ${entry.toolName} ${entry.summary}`, width))];
  if (entry.kind === "output" && drawOutput) return ["", ...drawOutput(entry), ""];
  return [dim("· (not shown)")];
};

// working: the word for the session at work ("working", "cooking").
export const chatMark = (session: ChatState["session"], working: string): string => {
  if (session === "working") return yellow(`◐ ${working}`);
  if (session === "needs-you") return yellow("⚠ needs you · ^A");
  if (session === "starting") return dim("○ starting");
  if (session === "gone") return dim("○ ended");
  return "● ready";
};

// The notice, the draft and the keys, under the conversation.
export const chatFooter = (state: ChatState, width: number, keys: string): string[] => [
  "",
  ...(state.notice ? [yellow(fit(state.notice, width))] : []),
  `› ${lastCells(state.draft, width - 3)}▏`,
  dim(keys),
];
