import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FACT_TYPES, LINK_ENV_KEYS, LINK_ROUTES, readCheckIn, readFacts, takeNextFacts, type Fact } from "../link/link-protocol";
import { MOD_FOLDER } from "../constants";
import { SESSION_LIMITS } from "../limits";

const factAt = (seq: number): Fact => ({ seq, type: "turn-start", atMs: 1, sessionId: "s", details: {} });

test("facts are taken in order from the one after the last, stopping at a gap", () => {
  expect(takeNextFacts(0, [factAt(1), factAt(2), factAt(3)])).toEqual({ taken: [factAt(1), factAt(2), factAt(3)], lastSeq: 3 });
  expect(takeNextFacts(0, [factAt(2), factAt(1)]).lastSeq).toBe(2);
  expect(takeNextFacts(1, [factAt(1), factAt(2)])).toEqual({ taken: [factAt(2)], lastSeq: 2 });
  expect(takeNextFacts(1, [factAt(3), factAt(4)])).toEqual({ taken: [], lastSeq: 1 });
  expect(takeNextFacts(5, [])).toEqual({ taken: [], lastSeq: 5 });
});

test("a post with one bad fact, or too many, is turned down whole", () => {
  expect(readFacts({ facts: [factAt(1)] })).toEqual([factAt(1)]);
  expect(readFacts({ facts: [factAt(1), { ...factAt(2), type: "made-up" }] })).toBeNull();
  expect(readFacts({ facts: [{ ...factAt(1), seq: 0 }] })).toBeNull();
  expect(readFacts({ facts: Array.from({ length: SESSION_LIMITS.maxFactsPerPost + 1 }, (_, index) => factAt(index + 1)) })).toBeNull();
  expect(readFacts({ facts: "no" })).toBeNull();
  expect(readFacts(null)).toBeNull();
});

test("a fact's details must be an object, or are dropped", () => {
  expect(readFacts({ facts: [{ ...factAt(1), details: ["x"] }] })?.[0]?.details).toEqual({});
});

test("a check-in needs every field, each short text", () => {
  const checkIn = { token: "t", sessionId: "s", version: "2.1.330", snapshot: "abc" };
  expect(readCheckIn(checkIn)).toEqual(checkIn);
  expect(readCheckIn({ ...checkIn, token: "" })).toBeNull();
  expect(readCheckIn({ ...checkIn, version: 2 })).toBeNull();
  expect(readCheckIn({ ...checkIn, snapshot: "x".repeat(SESSION_LIMITS.maxIdTextLength + 1) })).toBeNull();
});

// The mod can't import these, so it spells them out; they must match.
test("the mod's copies of the link's names match", () => {
  const modSource = [readFileSync(join(MOD_FOLDER, "hooks", "register.ts"), "utf8"), readFileSync(join(MOD_FOLDER, "helper.ts"), "utf8")].join("\n");
  const names = [...Object.values(LINK_ROUTES).map((route) => `http://talos${route}`), ...Object.values(LINK_ENV_KEYS), ...FACT_TYPES];
  expect(names.filter((name) => !modSource.includes(name))).toEqual([]);
  expect(modSource).toContain(`const MAX_FACTS_PER_POST = ${SESSION_LIMITS.maxFactsPerPost}`);
});
