import { afterEach, expect, setSystemTime, test } from "bun:test";
import { steadyNow } from "../constants";

afterEach(() => setSystemTime());

test("the runner's clock goes on forward when the system clock jumps back", () => {
  const before = steadyNow();
  setSystemTime(new Date(Date.now() - 3_600_000));
  expect(steadyNow()).toBeGreaterThanOrEqual(before);
  expect(Math.abs(steadyNow() - Date.now())).toBeGreaterThan(3_000_000);
});
