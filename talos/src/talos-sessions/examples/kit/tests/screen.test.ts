import { expect, test } from "bun:test";
import { bold, fit, fitScreen, padTo, visibleLength } from "../screen";

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
