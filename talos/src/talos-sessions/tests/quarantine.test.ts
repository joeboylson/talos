import { expect, test } from "bun:test";
import { quarantineLines } from "../runner/quarantine";
import { SESSION_LIMITS } from "../limits";

test("one batch never writes past the file's cap, however many or big its items", () => {
  const items = Array.from({ length: 100 }, () => ({ entryId: "x".repeat(300_000) }));
  expect(Buffer.byteLength(quarantineLines("s", items, 0))).toBeLessThanOrEqual(SESSION_LIMITS.maxQuarantineBytes);
});

test("every line is whole JSON, even for an item cut short or full of emoji", () => {
  const lines = quarantineLines("s", [{ text: "😀".repeat(200_000) }, { text: "ok" }], 0).trimEnd().split("\n");
  expect(lines.map((line) => JSON.parse(line).sessionName)).toEqual(["s", "s"]);
  expect(lines.every((line) => Buffer.byteLength(line) < 10_000)).toBe(true);
});
