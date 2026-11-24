// `talos sessions <session> attach`: a session's conversation in the
// terminal, as it happens, and a line to type into. It only ever adds lines,
// so the terminal's own scrollback and clear (Cmd-K) work as usual. Pure:
// what to print for each entry and each state, and what a typed line means.
// attach.ts does the reading and writing.
import { openDecisionOf, statusOf } from "talos-shared";
import { STATUS_KIND } from "./session-outputs";
import type { SessionEntry, SessionSummary } from "./talos-sessions";

export type AttachAction =
  | { do: "send"; text: string }
  | { do: "answer"; outputId: string; choice: number }
  | { do: "permission"; id: string; isAllowed: boolean }
  | { do: "nothing" };

// The colors a line may use; plain (each one leaving the text as it is) when
// the terminal shows none.
export type Paint = Record<"dim" | "bold" | "green" | "red" | "yellow" | "blue" | "cyan", (text: string) => string>;
const ANSI = { dim: [2, 22], bold: [1, 22], green: [32, 39], red: [31, 39], yellow: [33, 39], blue: [34, 39], cyan: [36, 39] } as const;
export const paintFor = (isColored: boolean): Paint =>
  Object.fromEntries(Object.entries(ANSI).map(([name, [on, off]]) => [name, (text: string) => (isColored ? `\x1b[${on}m${text}\x1b[${off}m` : text)])) as Paint;
export const PLAIN = paintFor(false);

// How talos sends a click on a question's choice (see talos-sessions' held.ts).
const ANSWER = /^Answer to [0-9a-f-]{36}: ([\s\S]*)$/;

const prefixed = (text: string, first: string, rest: string) => text.split("\n").map((line, index) => `${index === 0 ? first : rest}${line}`);

// One entry as lines, or none yet: a tool shows once it has finished, with
// how it went (while it runs, the state line names it).
export const entryLines = (entry: SessionEntry, paint: Paint = PLAIN): string[] => {
  // talos's own messages read as what they mean: a status request, a choice.
  if (entry.kind === "prompt" && entry.text === STATUS_KIND.requestText) return [paint.dim("  (asked for a status)")];
  const answered = entry.kind === "prompt" ? ANSWER.exec(entry.text)?.[1] : undefined;
  if (answered !== undefined) return [`${paint.cyan("›")} ${paint.bold(answered)}`];
  if (entry.kind === "prompt") {
    const images = entry.imageCount > 0 ? paint.dim(` [${entry.imageCount} image${entry.imageCount === 1 ? "" : "s"}]`) : "";
    return prefixed(`${entry.text}${images}`, paint.cyan("› "), "  ").map(paint.bold);
  }
  if (entry.kind === "text") return entry.text.split("\n");
  if (entry.kind === "tool") {
    if (entry.outcome === "running") return [];
    const mark = entry.outcome === "done" ? paint.green("✓") : paint.red("✗");
    return [`  ${mark} ${paint.dim(`${entry.toolName}${entry.summary ? ` ${entry.summary}` : ""}`)}`];
  }
  if (entry.kind === "dropped") return [paint.dim(`  (something here failed its check: ${entry.reason})`)];
  const { question, choices } = entry.fields as { question?: unknown; choices?: unknown };
  if (entry.outputKind === "decision" && typeof question === "string" && Array.isArray(choices)) {
    return [`${paint.yellow("?")} ${paint.bold(question)}`, ...choices.map((choice, index) => `  ${paint.yellow(`${index + 1})`)} ${String(choice)}`)];
  }
  return [paint.dim(`  [${entry.outputKind}] ${JSON.stringify(entry.fields)}`)];
};

// The longest a running tool's line may be in the prompt.
const TOOL_SHOWN_LENGTH = 50;

// The prompt you type at: the session's state, led by its dot as the page's
// badge shows it, and what it waits on or is running. It changes in place,
// so the conversation above holds only the conversation.
export const promptFor = (session: SessionSummary, runningTool: string | null = null, paint: Paint = PLAIN): string => {
  const [ask] = session.permissionAsks ?? [];
  const decision = openDecisionOf(session);
  const isAnswerable = decision !== null && session.isTurnOver !== false;
  const [dot, label] =
    session.state === "needs-you"
      ? [paint.yellow("●"), ask ? "allow? y/n" : isAnswerable ? `answer 1-${decision.choices.length}` : "needs you"]
      : session.state === "working"
        ? [paint.blue("●"), runningTool && runningTool.length > TOOL_SHOWN_LENGTH ? `${runningTool.slice(0, TOOL_SHOWN_LENGTH - 1)}…` : (runningTool ?? "working")]
        : session.state === "starting"
          ? [paint.dim("●"), "starting"]
          : [paint.green("●"), "ready"];
  const marks = [session.isSelfStarted && session.state === "working" ? "by Claude Code" : null, session.link === "lost" ? paint.red("link lost") : null].filter(Boolean);
  return `${dot} ${paint.dim(label)}${marks.length > 0 ? paint.dim(` · ${marks.join(paint.dim(" · "))}`) : ""} ${paint.cyan("›")} `;
};

// A permission question, as a line in the conversation: it waits on you.
export const permissionLine = (tool: string, summary: string, paint: Paint = PLAIN): string =>
  `${paint.yellow("?")} ${paint.bold(`Allow ${tool}?`)}${summary ? ` ${paint.dim(summary)}` : ""} ${paint.dim("y/n")}`;

// The status the session last reported when asked, as the page shows it.
export const statusLine = (session: SessionSummary, paint: Paint = PLAIN): string | null => {
  const status = statusOf(session);
  if (!status) return null;
  return paint.dim(`status: ${status.state}${status.note ? ` — ${status.note}` : ""}`);
};

// A permission question takes y or n; an open question takes its choice's
// number; anything else is a message.
export const readTyped = (line: string, session: SessionSummary): AttachAction => {
  const text = line.trim();
  if (!text) return { do: "nothing" };
  const [ask] = session.permissionAsks ?? [];
  if (ask && /^(y|yes|n|no)$/i.test(text)) return { do: "permission", id: ask.id, isAllowed: /^y/i.test(text) };
  const decision = openDecisionOf(session);
  const choice = Number(text);
  if (decision && Number.isInteger(choice) && choice >= 1 && choice <= decision.choices.length) {
    return { do: "answer", outputId: decision.id, choice: choice - 1 };
  }
  return { do: "send", text };
};

// Ctrl-C stops a running turn; with none running it leaves.
export const isTurnRunning = (session: SessionSummary): boolean => session.state === "working" || (session.state === "needs-you" && session.isTurnOver === false);
