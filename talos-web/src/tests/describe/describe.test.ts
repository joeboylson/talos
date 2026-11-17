import { expect, test } from "bun:test";
import { buildInitials, formatRoundTrip } from "../../describe";

test("buildInitials", () => {
  expect(buildInitials("joeboylson")).toBe("JO");
  expect(buildInitials("x")).toBe("X");
});

test("formatRoundTrip", () => {
  expect(formatRoundTrip(undefined)).toBe("—");
  expect(formatRoundTrip(0)).toBe("0 ms");
  expect(formatRoundTrip(12)).toBe("12 ms");
});
