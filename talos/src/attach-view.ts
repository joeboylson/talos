// `talos sessions <session> attach`: a session's conversation in the
// terminal, as it happens, and a line to type into. It only ever adds lines,
// so the terminal's own scrollback and clear (Cmd-K) work as usual. Pure:
// what to print for each entry and each state, and what a typed line means.
// attach.ts does the reading and writing.
import { openDecisionOf, statusOf } from "talos-shared";
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

const prefixed = (text: string, first: string, rest: string) => text.split("\n").map((line, index) => `${index === 0 ? first : rest}${line}`);

// One entry as lines, or none yet: a tool shows once it has finished, with
// how it went (while it runs, the state line names it).
export const entryLines = (entry: SessionEntry, paint: Paint = PLAIN): string[] => {
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

// What the session waits on now, in a line led by its state's dot, as the
// page's badge shows it; and the tool running now, if one is.
export const stateLine = (session: SessionSummary, runningTool: string | null = null, paint: Paint = PLAIN): string => {
  const [ask] = session.permissionAsks ?? [];
  const decision = openDecisionOf(session);
  const isAnswerable = decision !== null && session.isTurnOver !== false;
  const [dot, label] =
    session.state === "needs-you"
      ? [paint.yellow("●"), "needs you"]
      : session.state === "working"
        ? [paint.blue("●"), "working"]
        : session.state === "starting"
          ? [paint.dim("●"), "starting"]
          : [paint.green("●"), "ready"];
  const detail = ask
    ? `allow ${ask.tool}${ask.summary ? `: ${ask.summary}` : ""}? y/n`
    : isAnswerable
      ? `answer 1-${decision.choices.length}, or type your own`
      : session.state === "working"
        ? [runningTool, session.isSelfStarted ? "started by Claude Code" : null, "Ctrl-C stops it"].filter(Boolean).join(" · ")
        : "";
  const lost = session.link === "lost" ? paint.red(" · link lost") : "";
  return `${dot} ${label}${detail ? paint.dim(` · ${detail}`) : ""}${lost}`;
};

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
