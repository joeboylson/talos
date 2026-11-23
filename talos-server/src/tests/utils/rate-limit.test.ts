import { expect, test } from "bun:test";
import { allowAttempt, allowBytes } from "../../utils/rate-limit";

// The clock can jump back (NTP, a person changing it): a window or attempt
// from "after now" mustn't hold for the whole jump.
const HOUR_MS = 3_600_000;

test("attempts from before a clock jump back don't count against new ones", () => {
  const atNow = Date.now();
  const full = Array.from({ length: 10 }, () => atNow);
  expect(allowAttempt(full, atNow, { windowMs: 600_000, maxAttempts: 10 }).isAllowed).toBe(false);
  expect(allowAttempt(full, atNow - HOUR_MS, { windowMs: 600_000, maxAttempts: 10 }).isAllowed).toBe(true);
});

test("a byte budget used up before a clock jump back starts fresh", () => {
  const used = { startMs: Date.now(), bytes: 1000 };
  expect(allowBytes(used, used.startMs + 10, 10, { windowMs: 1000, maxBytes: 1000 }).isAllowed).toBe(false);
  expect(allowBytes(used, used.startMs - HOUR_MS, 10, { windowMs: 1000, maxBytes: 1000 }).isAllowed).toBe(true);
});
