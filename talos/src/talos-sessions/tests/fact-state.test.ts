import { expect, test } from "bun:test";
import { NO_FACTS, shownFactState, stepFactView, type FactView } from "../link/fact-state";
import type { Fact } from "../link/link-protocol";

let seq = 0;
const fact = (type: Fact["type"], details: Record<string, unknown> = {}): Fact => ({ seq: ++seq, type, atMs: 0, sessionId: "s", details });
const shownAfter = (...facts: Fact[]) => shownFactState(facts.reduce(stepFactView, NO_FACTS));
const viewAfter = (...facts: Fact[]): FactView => facts.reduce(stepFactView, NO_FACTS);
const TYPED = { origin: { kind: "composer" } };

test("a session is starting until its mod's start, then ready", () => {
  expect(shownAfter()).toBe("starting");
  expect(shownAfter(fact("session-start"))).toBe("idle");
});

test("a turn works until it completes; a sub-agent's turns don't count", () => {
  const started = [fact("session-start"), fact("turn-start", { turnId: "t" })];
  expect(shownAfter(...started)).toBe("working");
  expect(shownAfter(...started, fact("turn-complete", { turnId: "a", agentId: "x" }))).toBe("working");
  expect(shownAfter(...started, fact("turn-complete", { turnId: "t" }))).toBe("idle");
  expect(shownAfter(fact("session-start"), fact("turn-start", { agentId: "x" }))).toBe("idle");
});

test("a permission prompt needs the person until its call ends, or the turn does", () => {
  const asked = [fact("session-start"), fact("turn-start"), fact("permission-asked", { toolUseId: "u1" })];
  expect(shownAfter(...asked)).toBe("needs-you");
  expect(shownAfter(...asked, fact("permission-asked", { toolUseId: "u2" }), fact("permission-settled", { toolUseId: "u1" }))).toBe("needs-you");
  expect(shownAfter(...asked, fact("permission-settled", { toolUseId: "u1" }))).toBe("working");
  expect(shownAfter(...asked, fact("turn-complete"))).toBe("idle");
});

// Esc during a turn: Claude Code refuses sends until the person enters something.
test("Esc stops a session once its turn ends, until the person enters something", () => {
  const stopped = [fact("session-start"), fact("turn-start"), fact("session-stop", { isTurnRunning: true }), fact("turn-complete", { reason: "aborted" })];
  expect(shownAfter(...stopped.slice(0, 3))).toBe("working");
  expect(shownAfter(...stopped)).toBe("stopped");
  expect(shownAfter(...stopped, fact("turn-start"), fact("turn-complete"))).toBe("stopped");
  expect(shownAfter(...stopped, fact("prompt-submit", { origin: { kind: "plugin", name: "talos" } }))).toBe("stopped");
  expect(shownAfter(...stopped, fact("prompt-submit", TYPED))).toBe("idle");
  expect(shownAfter(...stopped, fact("prompt-submit", { origin: { kind: "bridge" } }), fact("turn-start"))).toBe("working");
});

test("a turn keeps who started it, and the default is Claude Code itself", () => {
  expect(viewAfter(fact("turn-start", { startedBy: "person" })).turnStarter).toBe("person");
  expect(viewAfter(fact("turn-start", { startedBy: "made-up" })).turnStarter).toBe("self");
  expect(viewAfter(fact("turn-start", { startedBy: "talos" }), fact("turn-complete")).turnStarter).toBeNull();
});

test("a /clear or /resume changes nothing on its own", () => {
  const ready = viewAfter(fact("session-start"));
  expect(stepFactView(ready, fact("session-end", { reason: "clear" }))).toBe(ready);
});

test("a stop with no turn running stops nothing", () => {
  expect(shownAfter(fact("session-start"), fact("session-stop", { isTurnRunning: false }))).toBe("idle");
  expect(shownAfter(fact("session-start"), fact("session-stop"))).toBe("idle");
});
