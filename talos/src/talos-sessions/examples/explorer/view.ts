// explorer: ask about a shop's sales, and see the session's answer as text with
// its charts, tables and numbers drawn in between, in the order it sent them.
import { mergeSessionEntries, type SessionEntry, type SessionSummary } from "../../index";
import { bar, bold, cyan, dim, fit, padTo, yellow } from "../kit/screen";
import { BACKSPACE, CTRL_A, ENTER, noActions, type ExampleView } from "../kit/view";

export const SUMMARY_REQUEST = "Summarize this data with send_summary.";
const KEPT_ENTRIES = 500;
const LABEL_WIDTH = 14;
const SPARKS = "▁▂▃▄▅▆▇█";

export type ExplorerState = {
  session: SessionSummary["state"] | "starting";
  entries: SessionEntry[];
  draft: string;
  notice: string;
};

type Fields = Record<string, unknown>;
const numberText = (value: number): string => (Number.isInteger(value) ? value.toLocaleString("en-GB") : value.toLocaleString("en-GB", { maximumFractionDigits: 2 }));

// Wraps plain text to the width, keeping its own line breaks.
const wrapText = (text: string, width: number): string[] =>
  text.split("\n").flatMap((paragraph) => {
    const words = paragraph.split(" ");
    return words.reduce<string[]>((lines, word) => {
      const last = lines.at(-1) ?? "";
      if (lines.length > 0 && (last + " " + word).length <= width) return [...lines.slice(0, -1), last ? `${last} ${word}` : word];
      return [...lines, word];
    }, []);
  });

export const drawBars = ({ title, labels, series }: Fields, width: number): string[] => {
  const names = labels as string[];
  const all = series as { name: string; values: number[] }[];
  const most = Math.max(...all.flatMap(({ values }) => values), 0);
  const valueWidth = Math.max(...all.flatMap(({ values }) => values.map((value) => numberText(value).length)));
  const barWidth = Math.max(width - LABEL_WIDTH - valueWidth - 3, 4);
  return [
    bold(String(title)),
    ...all.flatMap(({ name, values }) => [
      ...(all.length > 1 ? [dim(name)] : []),
      ...names.map((label, index) => `${padTo(fit(label, LABEL_WIDTH - 1), LABEL_WIDTH)}${cyan(padTo(bar(values[index]!, most, barWidth), barWidth))} ${numberText(values[index]!)}`),
    ]),
  ];
};

export const drawLine = ({ title, labels, series }: Fields): string[] => {
  const names = labels as string[];
  return [
    bold(String(title)),
    ...(series as { name: string; values: number[] }[]).map(({ name, values }) => {
      const [least, most] = [Math.min(...values), Math.max(...values)];
      const spark = values.map((value) => SPARKS[most === least ? 0 : Math.round(((value - least) / (most - least)) * (SPARKS.length - 1))]).join("");
      return `${padTo(fit(name, LABEL_WIDTH - 1), LABEL_WIDTH)}${cyan(spark)} ${dim(`${numberText(least)}–${numberText(most)}`)}`;
    }),
    dim(`${names[0]} … ${names.at(-1)}`),
  ];
};

export const drawTable = ({ title, columns, rows }: Fields, width: number): string[] => {
  const header = columns as string[];
  const cells = (rows as (string | number)[][]).map((row) => row.map((cell) => (typeof cell === "number" ? numberText(cell) : cell)));
  const widths = header.map((name, column) => Math.min(Math.max(name.length, ...cells.map((row) => row[column]!.length)), Math.max(Math.floor(width / header.length) - 2, 4)));
  const line = (row: string[]) => row.map((cell, column) => padTo(fit(cell, widths[column]!), widths[column]!)).join("  ");
  return [bold(String(title)), dim(line(header)), ...cells.map(line)];
};

const drawOutput = (entry: Extract<SessionEntry, { kind: "output" }>, width: number): string[] => {
  const { fields } = entry;
  if (entry.outputKind === "chart") return fields.type === "line" ? drawLine(fields) : drawBars(fields, width);
  if (entry.outputKind === "table") return drawTable(fields, width);
  if (entry.outputKind === "stat") return [`${bold(numberText(fields.value as number))}${fields.unit ? ` ${fields.unit}` : ""}  ${dim(String(fields.label))}`];
  if (entry.outputKind === "summary") {
    return [bold(`${numberText(fields.rows as number)} orders`) + dim(`  ${fields.from} → ${fields.to}`), ...(fields.highlights as string[]).map((line) => `• ${line}`)];
  }
  return [dim(JSON.stringify(fields))];
};

const drawEntry = (entry: SessionEntry, width: number): string[] => {
  if (entry.kind === "prompt") return ["", ...wrapText(entry.text, width - 2).map((line, index) => bold(`${index === 0 ? "›" : " "} ${line}`))];
  if (entry.kind === "text") return wrapText(entry.text, width);
  if (entry.kind === "tool") return [dim(fit(`· ${entry.toolName} ${entry.summary}`, width))];
  if (entry.kind === "output") return ["", ...drawOutput(entry, width), ""];
  return [dim("· (not shown)")];
};

const STATE_MARKS: Record<ExplorerState["session"], string> = {
  starting: dim("○ starting"),
  idle: "● ready",
  working: yellow("◐ working"),
  "needs-you": yellow("⚠ needs you · ^A"),
};

export const explorerView: ExampleView<ExplorerState> = {
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
    if (key === "s" && state.draft === "") return { state, actions: [{ do: "send", text: SUMMARY_REQUEST }] };
    const typed = key.replace(/[\x00-\x1f\x7f]/g, "");
    return noActions(typed ? { ...state, draft: state.draft + typed } : state);
  },
  render: (state, columns) => {
    const width = Math.max(columns, 40);
    return [
      `${bold("explorer")}  ${STATE_MARKS[state.session]}`,
      ...state.entries.flatMap((entry) => drawEntry(entry, width)),
      "",
      ...(state.notice ? [yellow(fit(state.notice, width))] : []),
      `› ${state.draft}▏`,
      dim("⏎ ask · s summary · ^A attach · ^C quit"),
    ];
  },
};
