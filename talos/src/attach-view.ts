// `talos sessions <session> attach`: a session's conversation in the
// terminal, as it happens, and a line to type into. Pure: what to print for
// each entry and each state, and what a typed line means. attach.ts does the
// reading and writing.
import { openDecisionOf } from "talos-shared";
import type { SessionEntry, SessionSummary } from "./talos-sessions";

export type AttachAction =
  | { do: "send"; text: string }
  | { do: "answer"; outputId: string; choice: number }
  | { do: "permission"; id: string; isAllowed: boolean }
  | { do: "nothing" };

const indent = (text: string, by: string) => text.split("\n").map((line) => `${by}${line}`);

// One entry as lines: the person's messages marked, Claude's words as they
// are, tools and the rest dimmed by an indent.
export const entryLines = (entry: SessionEntry): string[] => {
  if (entry.kind === "prompt") {
    const images = entry.imageCount > 0 ? ` [${entry.imageCount} image${entry.imageCount === 1 ? "" : "s"}]` : "";
    return indent(`${entry.text}${images}`, "› ");
  }
  if (entry.kind === "text") return entry.text.split("\n");
  if (entry.kind === "tool") return [`  · ${entry.toolName}${entry.summary ? ` ${entry.summary}` : ""}`];
  if (entry.kind === "dropped") return [`  (something here failed its check: ${entry.reason})`];
  const { question, choices } = entry.fields as { question?: unknown; choices?: unknown };
  if (entry.outputKind === "decision" && typeof question === "string" && Array.isArray(choices)) {
    return [`? ${question}`, ...choices.map((choice, index) => `  ${index + 1}) ${String(choice)}`)];
  }
  return [`  [${entry.outputKind}] ${JSON.stringify(entry.fields)}`];
};

// What the session waits on now, in a line, and how to answer it.
export const stateLine = (session: SessionSummary): string => {
  const [ask] = session.permissionAsks ?? [];
  if (ask) return `allow ${ask.tool}${ask.summary ? `: ${ask.summary}` : ""}? y/n`;
  const decision = openDecisionOf(session);
  if (decision && session.isTurnOver !== false) return `answer 1-${decision.choices.length}, or type your own`;
  if (session.state === "working") return "working (Ctrl-C stops it)";
  if (session.state === "starting") return "starting";
  return "ready";
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
