import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRecording, replay } from "../../kit/recording";
import { fitScreen } from "../../kit/screen";
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
    ["a value too big to draw", { ...chart, series: [{ name: "revenue", values: [-1e308, 1e308] }] }],
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
    expect(bars[2]).toBeGreaterThan(0);
    expect(lines.every((line) => line.length <= 60)).toBe(true);
  });
  test("negative bars run left of a line, positive ones right, both in proportion", () => {
    const lines = plain(drawBars({ title: "T", labels: ["loss", "small", "zero", "gain"], series: [{ name: "s", values: [-500, -5, 0, 1000] }] }, 60)).slice(1);
    const axis = lines.map((line) => line.indexOf("│"));
    expect(new Set(axis).size).toBe(1);
    const leftOf = (line: string) => (line.slice(0, axis[0]).match(/█/g) ?? []).length;
    const rightOf = (line: string) => (line.slice(axis[0]! + 1).match(/█/g) ?? []).length;
    expect(leftOf(lines[0]!)).toBeGreaterThan(leftOf(lines[1]!));
    expect([leftOf(lines[2]!), rightOf(lines[2]!)]).toEqual([0, 0]);
    expect(rightOf(lines[3]!)).toBeGreaterThan(leftOf(lines[0]!));
    expect(rightOf(lines[0]!)).toBe(0);
  });
  test("a chart with no negatives has no line", () => {
    expect(plain(drawBars({ title: "T", labels: ["a"], series: [{ name: "s", values: [3] }] }, 60)).join("")).not.toContain("│");
  });
  test("a table lines up its columns", () => {
    const [, header, row] = plain(drawTable({ title: "T", columns: ["name", "sold"], rows: [["Burr grinder", 12]] }, 80));
    expect(header!.indexOf("sold")).toBe(row!.indexOf("12"));
  });
});

describe("what's drawn is true to the data at any width", () => {
  const screen = (fields: Record<string, unknown>, outputKind: string, columns: number) => {
    const entry = { kind: "output" as const, position: 1, entryId: "o1", outputKind, fields };
    const state = explorerView.step(explorerView.initial, { type: "event", event: { type: "session-entries", sessionName: "example", entries: [entry] } }).state;
    return plain(fitScreen(explorerView.render(state, columns), columns, 100));
  };
  test("a line chart too long for the terminal shows its newest points and its real range", () => {
    const labels = Array.from({ length: 60 }, (_, index) => `d${index}`);
    const lines = screen({ title: "T", type: "line", labels, series: [{ name: "s", values: labels.map((_, index) => index * 1000) }] }, "chart", 80);
    const sparkLine = lines.find((line) => line.includes("▁") || line.includes("█"))!;
    expect(sparkLine).toMatch(/█ [\d,]+–59,000$/);
    expect(lines.some((line) => line.includes("d59"))).toBe(true);
  });
  test("in a narrow terminal, bars keep their values and their proportions", () => {
    const lines = screen({ title: "T", type: "bar", labels: ["a", "b"], series: [{ name: "s", values: [100, 50] }] }, "chart", 30);
    const [first, second] = lines.filter((line) => /^[ab] /.test(line));
    expect([first, second].map((line) => line!.includes("100") || line!.includes("50"))).toEqual([true, true]);
    expect((first!.match(/█/g) ?? []).length).toBeGreaterThan((second!.match(/█/g) ?? []).length);
  });
  test("a number in a table is never cut, however many columns", () => {
    const columns = ["name", "a", "b", "c", "d", "e", "f", "total"];
    const lines = screen({ title: "T", columns, rows: [["Kettle with a long name", 1, 2, 3, 4, 5, 6, 1234567890]] }, "table", 80);
    expect(lines.some((line) => line.includes("1,234,567,890"))).toBe(true);
  });
  test("small decimals keep their digits, and nothing shows as -0", () => {
    expect(screen({ label: "rate", value: 0.004, unit: "" }, "stat", 80).some((line) => line.startsWith("0.004"))).toBe(true);
    expect(screen({ label: "drift", value: -0.0001, unit: "" }, "stat", 80).some((line) => line.startsWith("-0.0001"))).toBe(true);
    expect(screen({ title: "T", type: "line", labels: ["a", "b", "c"], series: [{ name: "s", values: [0.001, 0.002, 0.004] }] }, "chart", 80).join("\n")).toContain("0.001–0.004");
  });
  test("wide characters in a table take their room on screen and aren't cut when there's room", () => {
    expect(screen({ title: "T", columns: ["city", "sold"], rows: [["東京都", 3]] }, "table", 80).some((line) => line.includes("東京都"))).toBe(true);
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

describe("the shop's data", () => {
  const dataFolder = join(import.meta.dir, "../data");
  test("the session may run sqlite3 only safe and read-only on shop.db, the way CLAUDE.md shows", () => {
    const allowed: string[] = JSON.parse(readFileSync(join(dataFolder, ".claude/settings.json"), "utf8")).permissions.allow;
    const sqliteRules = allowed.filter((rule) => rule.startsWith("Bash(sqlite3"));
    expect(sqliteRules).toEqual(["Bash(sqlite3 -safe -readonly -header -column shop.db:*)"]);
    expect(readFileSync(join(dataFolder, "CLAUDE.md"), "utf8")).toContain("sqlite3 -safe -readonly -header -column shop.db ");
  });
  test(
    "builds at once, or one that fails, never leave a broken shop.db",
    async () => {
      const folder = mkdtempSync(join(tmpdir(), "talos-shop-"));
      const file = join(folder, "shop.db");
      const build = new URL("../data/build.ts", import.meta.url).pathname;
      const script = `import { buildShop } from ${JSON.stringify(build)}; buildShop(${JSON.stringify(file)});`;
      for (const _round of [1, 2, 3, 4, 5, 6]) {
        await Promise.all([1, 2, 3, 4].map(() => Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "ignore" }).exited));
        const shop = new Database(file, { readonly: true });
        expect(shop.query("SELECT COUNT(*) AS count FROM orders").get()).toEqual({ count: 1288 });
        shop.close();
      }
      expect(readdirSync(folder)).toEqual(["shop.db"]);
      rmSync(folder, { recursive: true, force: true });
    },
    60_000,
  );
});
