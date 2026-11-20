// explorer's kinds: what the session can hand back besides its text. Each is
// sent on its own in a prose turn and doesn't wait. Each check takes only the
// fields the view can draw, cleaned, and says plainly what's wrong otherwise.
import { cleanLine, type OutputKind } from "../../index";

export const MAX_LABELS = 60;
export const MAX_SERIES = 4;
export const MAX_ROWS = 40;
export const MAX_COLUMNS = 8;
const MAX_TEXT = 80;

type Fields = Record<string, unknown>;
const field = (input: unknown, name: string): unknown => (typeof input === "object" && input !== null ? Reflect.get(input, name) : undefined);
const shortText = (value: unknown): string | null => (typeof value === "string" && value.length <= MAX_TEXT ? cleanLine(value) : null);
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const textList = (value: unknown, most: number): string[] | null => {
  if (!Array.isArray(value) || value.length === 0 || value.length > most) return null;
  const texts = value.map(shortText);
  return texts.every((text) => text !== null) ? (texts as string[]) : null;
};

export const readChart = (input: unknown): Fields | null => {
  const title = shortText(field(input, "title"));
  const type = field(input, "type");
  const labels = textList(field(input, "labels"), MAX_LABELS);
  const series = field(input, "series");
  if (title === null || (type !== "bar" && type !== "line") || !labels || !Array.isArray(series) || series.length === 0 || series.length > MAX_SERIES) return null;
  const readSeries = series.map((one) => {
    const name = shortText(field(one, "name"));
    const values = field(one, "values");
    return name !== null && Array.isArray(values) && values.length === labels.length && values.every(isNumber) ? { name, values } : null;
  });
  return readSeries.every((one) => one !== null) ? { title, type, labels, series: readSeries } : null;
};

export const readTable = (input: unknown): Fields | null => {
  const title = shortText(field(input, "title"));
  const columns = textList(field(input, "columns"), MAX_COLUMNS);
  const rows = field(input, "rows");
  if (title === null || !columns || !Array.isArray(rows) || rows.length > MAX_ROWS) return null;
  const readRows = rows.map((row) =>
    Array.isArray(row) && row.length === columns.length && row.every((cell) => isNumber(cell) || shortText(cell) !== null)
      ? row.map((cell) => (isNumber(cell) ? cell : shortText(cell)))
      : null,
  );
  return readRows.every((row) => row !== null) ? { title, columns, rows: readRows } : null;
};

export const readStat = (input: unknown): Fields | null => {
  const label = shortText(field(input, "label"));
  const value = field(input, "value");
  const unit = field(input, "unit") === undefined ? "" : shortText(field(input, "unit"));
  return label !== null && isNumber(value) && unit !== null ? { label, value, unit } : null;
};

export const readSummary = (input: unknown): Fields | null => {
  const rows = field(input, "rows");
  const from = shortText(field(input, "from"));
  const to = shortText(field(input, "to"));
  const highlights = textList(field(input, "highlights"), 6);
  return isNumber(rows) && from !== null && to !== null && highlights ? { rows, from, to, highlights } : null;
};

const kind = (name: string, toolName: string, description: string, inputSchema: object, readFields: OutputKind["readFields"], badInputReason: string): OutputKind => ({
  kind: name,
  toolName,
  description,
  inputSchema,
  readFields,
  badInputReason,
  typedFields: {},
  waits: false,
});

const text = { type: "string", maxLength: MAX_TEXT };
export const CHART = kind(
  "chart",
  "send_chart",
  "Show a chart with your answer. Use it for anything with a trend or a comparison.",
  {
    type: "object",
    properties: {
      title: text,
      type: { type: "string", enum: ["bar", "line"] },
      labels: { type: "array", items: text, maxItems: MAX_LABELS },
      series: { type: "array", maxItems: MAX_SERIES, items: { type: "object", properties: { name: text, values: { type: "array", items: { type: "number" } } } } },
    },
    required: ["title", "type", "labels", "series"],
  },
  readChart,
  `Call send_chart with a title, type bar or line, at most ${MAX_LABELS} labels, and 1 to ${MAX_SERIES} series, each with one number per label.`,
);
export const TABLE = kind(
  "table",
  "send_table",
  "Show a table with your answer, for rows of facts.",
  { type: "object", properties: { title: text, columns: { type: "array", items: text, maxItems: MAX_COLUMNS }, rows: { type: "array", maxItems: MAX_ROWS, items: { type: "array" } } }, required: ["title", "columns", "rows"] },
  readTable,
  `Call send_table with a title, at most ${MAX_COLUMNS} columns, and at most ${MAX_ROWS} rows, each with one short text or number per column.`,
);
export const STAT = kind(
  "stat",
  "send_stat",
  "Show one headline number with your answer.",
  { type: "object", properties: { label: text, value: { type: "number" }, unit: text }, required: ["label", "value"] },
  readStat,
  "Call send_stat with a label, a number, and an optional unit.",
);
export const SUMMARY = kind(
  "summary",
  "send_summary",
  "Summarize the whole dataset: how many orders, the dates it covers, and a few highlights.",
  { type: "object", properties: { rows: { type: "number" }, from: text, to: text, highlights: { type: "array", items: text, maxItems: 6 } }, required: ["rows", "from", "to", "highlights"] },
  readSummary,
  "Call send_summary with the number of orders, the first and last date, and up to 6 short highlights.",
);

export const KINDS = [CHART, TABLE, STAT, SUMMARY];
export const PROSE_TURN = { output: "prose", optional: KINDS.map(({ kind: name }) => name) };
