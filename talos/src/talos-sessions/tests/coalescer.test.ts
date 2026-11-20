import { describe, expect, test } from "bun:test";
import { createCoalescer } from "../coalescer";

describe("createCoalescer", () => {
  test("collapses a burst into one run per window, then re-arms", () => {
    let runs = 0;
    const scheduled: (() => void)[] = [];
    const coalesced = createCoalescer(
      () => { runs += 1; },
      100,
      (fn) => scheduled.push(fn),
    );
    for (let i = 0; i < 50; i += 1) coalesced(); // a burst of 50 calls
    expect(scheduled.length).toBe(1); // only one run scheduled
    scheduled[0](); // the window elapses
    expect(runs).toBe(1);
    coalesced(); // a new call after the run re-arms
    expect(scheduled.length).toBe(2);
  });
});
