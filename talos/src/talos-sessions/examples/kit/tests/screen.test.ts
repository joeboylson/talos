import { expect, test } from "bun:test";
import { bold, fit, fitScreen, frame, padTo, visibleLength, wrapText } from "../screen";

test("a line is cut to the terminal's cells, colours kept whole and closed", () => {
  const cut = fit(`${bold("receipts")} ${"x".repeat(100)}`, 20);
  expect(visibleLength(cut)).toBe(20);
  expect(cut).toStartWith("\x1b[1mreceipts\x1b[22m");
  expect(cut).toEndWith("\x1b[0m…");
  expect(fit("short", 20)).toBe("short");
});

test("wide characters take two cells", () => {
  expect(visibleLength("数据")).toBe(4);
  expect(visibleLength(fit("数据数据数据", 5))).toBeLessThanOrEqual(5);
  expect(visibleLength(padTo("数据", 6))).toBe(6);
});

test("the screen keeps the newest lines that fit, none wider than the terminal", () => {
  const lines = ["header", "a".repeat(300), "b", "c"];
  expect(fitScreen(lines, 80, 3).map(visibleLength)).toEqual([80, 1, 1]);
});

test("a cut keeps an emoji whole, with its skin tone", () => {
  expect(fit("ok 👍🏽👍🏽👍🏽", 7)).toBe("ok 👍🏽\x1b[0m…");
});

test("a tab counts as the room it takes on screen", () => {
  expect(wrapText("month\ttotal\torders\taverage", 30).every((line) => visibleLength(line) <= 30)).toBe(true);
  expect(wrapText("a\tb", 80)).toEqual(["a  b"]);
});

test("no colour when NO_COLOR is set or the terminal is dumb", () => {
  const before = { noColor: process.env.NO_COLOR, term: process.env.TERM };
  process.env.NO_COLOR = "1";
  expect(bold("x")).toBe("x");
  delete process.env.NO_COLOR;
  process.env.TERM = "dumb";
  expect(bold("x")).toBe("x");
  process.env.TERM = "xterm-256color";
  expect(bold("x")).toBe("\x1b[1mx\x1b[22m");
  if (before.noColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = before.noColor;
  process.env.TERM = before.term;
});

test("a frame is drawn over the last one in place, never a full clear", () => {
  const drawn = frame(["one", "two"]);
  expect(drawn).not.toContain("\x1b[2J");
  expect(drawn).toBe("\x1b[Hone\x1b[K\r\ntwo\x1b[K\x1b[J");
});
