// explorer: ask about a shop's sales, and see the session's answer as text with
// its charts, tables and numbers drawn in between, in the order it sent them.
import { mergeSessionEntries, type SessionEntry, type SessionSummary } from "../../index";
import { bar, bold, cyan, dim, fit, lastCells, padTo, red, visibleLength, wrapText, yellow } from "../kit/screen";
import { CTRL_A, exampleSession, noActions, typeIntoDraft, type ExampleView } from "../kit/view";

export const SUMMARY_REQUEST = "Summarize this data with send_summary.";
const KEPT_ENTRIES = 500;
// Labels take up to 14 cells, less on a narrow screen so the data still shows.
const labelWidthFor = (width: number) => Math.min(14, Math.max(Math.floor(width / 3), 2));
const SPARKS = "▁▂▃▄▅▆▇█";

export type ExplorerState = {
  session: SessionSummary["state"] | "starting" | "gone";
  entries: SessionEntry[];
  draft: string;
  notice: string;
};

type Fields = Record<string, unknown>;
// Two decimals, but a small number keeps 3 digits that say something, so 0.004
// isn't shown as 0. Never -0.
const numberText = (value: number): string => {
  if (Number.isInteger(value)) return (value === 0 ? 0 : value).toLocaleString("en-GB");
  const digits = Math.abs(value) < 1 ? { maximumSignificantDigits: 3 } : { maximumFractionDigits: 2 };
  return value.toLocaleString("en-GB", digits);
};

// With negative values, the bars meet at a line: negatives run left of it in
// red, positives right of it in cyan, each side sized to its share of the range.
export const drawBars = ({ title, labels, series }: Fields, width: number): string[] => {
  const names = labels as string[];
  const all = series as { name: string; values: number[] }[];
  const values = all.flatMap(({ values: seriesValues }) => seriesValues);
  const most = Math.max(...values, 0);
  const least = Math.min(...values, 0);
  const valueWidth = Math.max(...values.map((value) => numberText(value).length));
  const labelWidth = labelWidthFor(width);
  const hasNegatives = least < 0;
  const barWidth = Math.max(width - labelWidth - valueWidth - 2 - (hasNegatives ? 1 : 0), 1);
  const leftWidth = hasNegatives ? Math.max(Math.round((barWidth * -least) / (most - least)), 1) : 0;
  const rightWidth = Math.max(barWidth - leftWidth, hasNegatives ? 0 : 1);
  const barOf = (value: number) => {
    if (!hasNegatives) return cyan(bar(value, most, rightWidth));
    const left = value < 0 ? bar(-value, -least, leftWidth) : "";
    return `${" ".repeat(leftWidth - visibleLength(left))}${red(left)}${dim("│")}${cyan(value > 0 ? bar(value, most, rightWidth) : "")}`;
  };
  // The value before its bar, so a narrow screen shortens bars, never values.
  return [
    bold(String(title)),
    ...all.flatMap(({ name, values: seriesValues }) => [
      ...(all.length > 1 ? [dim(name)] : []),
      ...names.map((label, index) => `${padTo(fit(label, labelWidth - 1), labelWidth)}${numberText(seriesValues[index]!).padStart(valueWidth)} ${barOf(seriesValues[index]!)}`),
    ]),
  ];
};

// A line too long for the screen shows its newest points; the range is of the
// points shown, and so are the first and last labels.
export const drawLine = ({ title, labels, series }: Fields, width: number): string[] => {
  const names = labels as string[];
  const all = series as { name: string; values: number[] }[];
  const labelWidth = labelWidthFor(width);
  const rangeOf = (values: number[]) => `${numberText(Math.min(...values))}–${numberText(Math.max(...values))}`;
  // Room for the widest range any points shown could have.
  const longestRange = 2 * Math.max(...all.flatMap(({ values }) => values.map((value) => numberText(value).length))) + 1;
  const shown = Math.max(Math.min(names.length, width - labelWidth - longestRange - 1), 1);
  return [
    bold(String(title)),
    ...all.map(({ name, values }) => {
      const kept = values.slice(-shown);
      const [least, most] = [Math.min(...kept), Math.max(...kept)];
      const spark = kept.map((value) => SPARKS[most === least ? 0 : Math.round(((value - least) / (most - least)) * (SPARKS.length - 1))]).join("");
      return `${padTo(fit(name, labelWidth - 1), labelWidth)}${cyan(spark)} ${dim(rangeOf(kept))}`;
    }),
    dim(`${names.at(-shown)} … ${names.at(-1)}`),
  ];
};

// Numbers are never cut (a cut one reads as another number): number columns
// take their full width, and text columns share what's left.
export const drawTable = ({ title, columns, rows }: Fields, width: number): string[] => {
  const header = columns as string[];
  const rawRows = rows as (string | number)[][];
  const cells = rawRows.map((row) => row.map((cell) => (typeof cell === "number" ? numberText(cell) : cell)));
  const isNumbers = header.map((_name, column) => rawRows.some((row) => typeof row[column] === "number"));
  const fullWidths = header.map((name, column) => Math.max(visibleLength(name), ...cells.map((row) => visibleLength(row[column]!))));
  const numbersWidth = fullWidths.filter((_width, column) => isNumbers[column]).reduce((total, one) => total + one, 0);
  const textColumns = isNumbers.filter((isNumber) => !isNumber).length;
  const textRoom = Math.max(Math.floor((width - numbersWidth - 2 * (header.length - 1)) / Math.max(textColumns, 1)), 4);
  const widths = fullWidths.map((full, column) => (isNumbers[column] ? full : Math.min(full, textRoom)));
  const line = (row: string[]) => row.map((cell, column) => padTo(isNumbers[column] ? cell : fit(cell, widths[column]!), widths[column]!)).join("  ");
  return [bold(String(title)), dim(line(header)), ...cells.map(line)];
};

const drawOutput = (entry: Extract<SessionEntry, { kind: "output" }>, width: number): string[] => {
  const { fields } = entry;
  if (entry.outputKind === "chart") return fields.type === "line" ? drawLine(fields, width) : drawBars(fields, width);
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
  gone: dim("○ ended"),
  idle: "● ready",
  working: yellow("◐ working"),
  "needs-you": yellow("⚠ needs you · ^A"),
};

export const explorerView: ExampleView<ExplorerState> = {
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
    if (key === "s" && state.draft === "") return { state, actions: [{ do: "send", text: SUMMARY_REQUEST }] };
    const { draft, sent } = typeIntoDraft(state.draft, key);
    return { state: { ...state, draft }, actions: sent.map((text) => ({ do: "send" as const, text })) };
  },
  render: (state, columns) => {
    const width = Math.max(columns, 1);
    return [
      `${bold("explorer")}  ${STATE_MARKS[state.session]}`,
      ...state.entries.flatMap((entry) => drawEntry(entry, width)),
      "",
      ...(state.notice ? [yellow(fit(state.notice, width))] : []),
      `› ${lastCells(state.draft, width - 3)}▏`,
      dim("⏎ ask · s summary · ^A attach · ^C quit"),
    ];
  },
};
