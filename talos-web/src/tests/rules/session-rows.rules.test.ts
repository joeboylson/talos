import { expect, test } from "bun:test";
import fc from "fast-check";
import { SESSION_STATES, type MachineSummary } from "talos-shared";
import { buildSessionRows, removeAnsweredPrompt, type WaitingPrompt } from "../../session-rows";

const RUNS = 2000;
const name = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,7}$/);
const state = fc.constantFrom(...SESSION_STATES);

const session = fc.record({
  sessionName: name,
  folderName: name,
  state,
  asks: fc.constant({}),
  openOutputs: fc.constant([]),
});

const machine = fc.record({
  machineId: fc.uuid(),
  machineName: name,
  isConnected: fc.boolean(),
  folders: fc.constant([]),
  sessions: fc.option(fc.uniqueArray(session, { selector: (s) => s.sessionName, maxLength: 6 }), { nil: null }),
}) as fc.Arbitrary<MachineSummary>;

const keysOf = (machines: MachineSummary[]) =>
  machines.flatMap(({ machineId, sessions }) => (sessions ?? []).map((s) => `${machineId}/${s.sessionName}`)).sort();

test("buildSessionRows keeps every session exactly once", () => {
  fc.assert(
    fc.property(fc.array(machine, { maxLength: 6 }), (machines) => {
      const rows = buildSessionRows(machines);
      expect(rows.map((row) => `${row.machineId}/${row.sessionName}`).sort()).toEqual(keysOf(machines));
    }),
    { seed: 20261120, numRuns: RUNS },
  );
});

test("buildSessionRows is sorted by machine name, then session name", () => {
  fc.assert(
    fc.property(fc.array(machine, { maxLength: 6 }), (machines) => {
      const rows = buildSessionRows(machines);
      rows.slice(1).forEach((row, index) => {
        const before = rows[index]!;
        const order = before.machineName.localeCompare(row.machineName) || before.sessionName.localeCompare(row.sessionName);
        expect(order).toBeLessThanOrEqual(0);
      });
    }),
    { seed: 20261121, numRuns: RUNS },
  );
});

test("a row has a status or decision only when its session has one", () => {
  fc.assert(
    fc.property(fc.array(machine, { maxLength: 6 }), (machines) => {
      buildSessionRows(machines).forEach((row) => {
        expect(row.status).toBeUndefined();
        expect(row.decision).toBeUndefined();
      });
    }),
    { seed: 20261122, numRuns: RUNS },
  );
});

const text = fc.constantFrom("hi", "hi ", " hi", "again", "", "look\n", "look");
const waiting: fc.Arbitrary<WaitingPrompt> = fc.record({
  text: text.map((t) => t.trim()),
  imagePreviewUrls: fc.array(fc.constant("blob:x"), { maxLength: 3 }),
});
const saved = fc.record({ kind: fc.constant("prompt" as const), position: fc.constant(0), entryId: fc.constant("e"), text, imageCount: fc.nat(3) });
const matches = (prompt: WaitingPrompt, answer: { text: string; imageCount: number }) =>
  prompt.text === answer.text.trim() && prompt.imagePreviewUrls.length === answer.imageCount;

test("removeAnsweredPrompt removes exactly the first matching prompt, or nothing", () => {
  fc.assert(
    fc.property(fc.array(waiting, { maxLength: 8 }), saved, (prompts, answer) => {
      const firstMatch = prompts.findIndex((prompt) => matches(prompt, answer));
      const expected = firstMatch === -1 ? prompts : prompts.filter((_, index) => index !== firstMatch);
      expect(removeAnsweredPrompt(prompts, answer)).toEqual(expected);
    }),
    { seed: 20261123, numRuns: RUNS },
  );
});

// The page keeps the sent text trimmed while it waits; Claude Code saves what was sent.
test("every sent message clears its own waiting prompt once saved, in the order sent", () => {
  const sent = fc.record({ text, imageCount: fc.nat(3) });
  fc.assert(
    fc.property(fc.array(sent, { maxLength: 8 }), (messages) => {
      const waitingPrompts = messages.map(({ text: t, imageCount }) => ({
        text: t.trim(),
        imagePreviewUrls: Array.from({ length: imageCount }, () => "blob:x"),
      }));
      const savedPrompts = messages.map((m) => ({ kind: "prompt" as const, position: 0, entryId: "e", ...m }));
      expect(savedPrompts.reduce(removeAnsweredPrompt, waitingPrompts)).toEqual([]);
    }),
    { seed: 20261124, numRuns: RUNS },
  );
});
