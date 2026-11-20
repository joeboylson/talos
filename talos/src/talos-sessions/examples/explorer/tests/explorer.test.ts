import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readRecording, replay } from "../../kit/recording";
import { BACKSPACE, ENTER } from "../../kit/view";
import { KINDS, MAX_LABELS, PROSE_TURN, readChart, readStat, readSummary, readTable } from "../kinds";
import { SUMMARY_REQUEST, drawBars, drawTable, explorerView } from "../view";

const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
const chart = { title: "Sales", type: "bar", labels: ["Jan", "Feb"], series: [{ name: "revenue", values: [10, 20] }] };

describe("explorer's kinds", () => {
  test("a good chart, table, stat and summary are kept", () => {
    expect(readChart(chart)).toEqual(chart);
    expect(readTable({ title: "Top", columns: ["name", "sold"], rows: [["Kettle", 3]] })).toEqual({ title: "Top", columns: ["name", "sold"], rows: [["Kettle", 3]] });
    expect(readStat({ label: "Orders", value: 1408 })).toEqual({ label: "Orders", value: 1408, unit: "" });
    expect(readSummary({ rows: 1408, from: "2025-01-01", to: "2025-12-31", highlights: ["December was biggest"] })).toMatchObject({ rows: 1408 });
  });
  test.each([
    ["series that don't match their labels", { ...chart, series: [{ name: "revenue", values: [10] }] }],
    ["a type it can't draw", { ...chart, type: "pie" }],
    ["too many labels", { ...chart, labels: Array.from({ length: MAX_LABELS + 1 }, (_, index) => `${index}`), series: [{ name: "r", values: Array(MAX_LABELS + 1).fill(1) }] }],
    ["a value that isn't a number", { ...chart, series: [{ name: "revenue", values: [10, "20"] }] }],
  ])("a chart with %s is turned down", (_name, input) => {
    expect(readChart(input)).toBeNull();
  });
  test("a table row with the wrong number of cells is turned down", () => {
    expect(readTable({ title: "Top", columns: ["name", "sold"], rows: [["Kettle"]] })).toBeNull();
  });
  test("text is cleaned before it's drawn", () => {
    expect(readStat({ label: "Ord\u001b[31mers\n", value: 1 })).toMatchObject({ label: "Ord[31mers" });
  });
  test("a prose turn may send every kind, and none of them waits", () => {
    expect(PROSE_TURN.optional).toEqual(["chart", "table", "stat", "summary"]);
    expect(KINDS.every(({ waits }) => !waits)).toBe(true);
  });
});

describe("drawing", () => {
  test("bars are in proportion, and an empty, negative or very long label still draws", () => {
    const lines = plain(drawBars({ title: "T", labels: ["", "x".repeat(50), "neg"], series: [{ name: "s", values: [10, 5, -3] }] }, 60));
    const bars = lines.slice(1).map((line) => (line.match(/█/g) ?? []).length);
    expect(bars[0]).toBeGreaterThan(bars[1]!);
    expect(bars[2]).toBe(0);
    expect(lines.every((line) => line.length <= 60)).toBe(true);
  });
  test("a table lines up its columns", () => {
    const [, header, row] = plain(drawTable({ title: "T", columns: ["name", "sold"], rows: [["Burr grinder", 12]] }, 80));
    expect(header!.indexOf("sold")).toBe(row!.indexOf("12"));
  });
});

describe("the view", () => {
  const typed = (keys: string[]) => keys.reduce((state, key) => explorerView.step(state, { type: "key", key }).state, explorerView.initial);
  test("typing builds the question, backspace takes a letter off, and Enter sends it", () => {
    const state = typed(["revenu", "e!", BACKSPACE]);
    expect(state.draft).toBe("revenue");
    expect(explorerView.step(state, { type: "key", key: ENTER }).actions).toEqual([{ do: "send", text: "revenue" }]);
  });
  test("s with nothing typed asks for a summary", () => {
    expect(explorerView.step(explorerView.initial, { type: "key", key: "s" }).actions).toEqual([{ do: "send", text: SUMMARY_REQUEST }]);
  });
  test("a refusal shows its reason", () => {
    const state = explorerView.step(explorerView.initial, { type: "result", action: { do: "send", text: "x" }, result: { ok: false, code: "no-such-session", reason: "no session example" } }).state;
    expect(plain(explorerView.render(state, 80)).join("\n")).toContain("no session example");
  });
  test("the recorded run replays: the question, the chart in its place, then the text", () => {
    const recording = readRecording(readFileSync(join(import.meta.dir, "../recordings/run.jsonl"), "utf8"));
    const { state, actions } = replay(explorerView, recording);
    expect(actions).toEqual([{ do: "send", text: "Show revenue per month in 2025 as a bar chart." }]);
    expect(state.entries.map((entry) => (entry.kind === "output" ? entry.outputKind : entry.kind)).filter((kind) => kind !== "tool")).toEqual(["prompt", "chart", "text"]);
    expect(plain(explorerView.render(state, 90)).filter((line) => line.includes("█"))).toHaveLength(12);
  });
});
