import { describe, expect, test } from "bun:test";
import { NO_OUTPUTS, NO_PLACING, placeOutputs, stepOutputs, type Outputs, type TakenOutput } from "../lanes/outputs";
import { SESSION_LIMITS } from "../limits";

const takenOf = (id: string, toolUseId = `tu-${id}`, waits = true): TakenOutput => ({ id, toolUseId, kind: "note", fields: { text: id }, atMs: 1, waits });
const take = (outputs: Outputs, output: TakenOutput) => stepOutputs(outputs, { type: "sent", output });
const sent = (outputs: Outputs, output: TakenOutput) => take(outputs, output).outputs;
const openIds = (outputs: Outputs) => outputs.open.map(({ id }) => id);
const started = (outputs: Outputs, isPersonTurn: boolean) => stepOutputs(outputs, { type: "turn-started", isPersonTurn }).outputs;
const ended = (outputs: Outputs) => stepOutputs(outputs, { type: "turn-ended" }).outputs;

describe("an output is taken when its call is answered", () => {
  test("one that waits opens", () => {
    const a = takenOf("a");
    const step = take(NO_OUTPUTS, a);
    expect(openIds(step.outputs)).toEqual(["a"]);
    expect(step.opened).toEqual(a);
  });
  test("one that doesn't wait counts, but isn't left open", () => {
    const a = takenOf("a", "tu-a", false);
    const step = take(NO_OUTPUTS, a);
    expect(step.opened).toEqual(a);
    expect(step.outputs.open).toEqual([]);
  });
});

describe("a question lasts one turn", () => {
  const asked = sent(started(NO_OUTPUTS, true), takenOf("a"));
  test("the turn that asked it ending leaves it open", () => {
    expect(openIds(ended(asked))).toEqual(["a"]);
  });
  test("the person's next turn ending closes it", () => {
    const step = stepOutputs(started(ended(asked), true), { type: "turn-ended" });
    expect(step.outputs.open).toEqual([]);
    expect(step.closedIds).toEqual(["a"]);
  });
  test("a turn talos sent, or one Claude Code started on its own, doesn't count as its next turn", () => {
    expect(openIds(ended(started(ended(asked), false)))).toEqual(["a"]);
  });
  test("an answer closes just its own question", () => {
    const both = sent(asked, takenOf("b"));
    expect(openIds(stepOutputs(both, { type: "answered", id: "a" }).outputs)).toEqual(["b"]);
  });
});

describe("open outputs are capped", () => {
  test("past the cap, the oldest closes", () => {
    const outputs = Array.from({ length: SESSION_LIMITS.maxOpenOutputs + 1 }, (_unused, i) => takenOf(`o${i}`)).reduce(sent, NO_OUTPUTS);
    expect(outputs.open.length).toBe(SESSION_LIMITS.maxOpenOutputs);
    expect(openIds(outputs)[0]).toBe("o1");
  });
});

describe("an output's place in the conversation", () => {
  const output = takenOf("a", "tu-a");
  test("an output that went through waits for its call's place, then takes it", () => {
    const first = placeOutputs(NO_PLACING, [output], []);
    expect(first.placed).toEqual([]);
    expect(placeOutputs(first.placing, [], [{ toolUseId: "tu-a", position: 7 }])).toEqual({ placing: NO_PLACING, placed: [{ output, position: 7 }] });
  });
  test("a call's place read first waits for its output", () => {
    const first = placeOutputs(NO_PLACING, [], [{ toolUseId: "tu-a", position: 7 }]);
    expect(placeOutputs(first.placing, [output], []).placed).toEqual([{ output, position: 7 }]);
  });
  const placesOf = (count: number, prefix: string) => Array.from({ length: count }, (_unused, index) => ({ toolUseId: `${prefix}${index}`, position: index }));
  test("more outputs than can be left open, in one message or one read, all find their place", () => {
    const outputs = Array.from({ length: SESSION_LIMITS.maxOpenOutputs + 1 }, (_unused, index) => takenOf(`o${index}`, `t${index}`));
    const places = placesOf(outputs.length, "t");
    expect(placeOutputs(placeOutputs(NO_PLACING, [], places).placing, outputs, []).placed).toHaveLength(outputs.length);
    expect(placeOutputs(placeOutputs(NO_PLACING, outputs, []).placing, [], places).placed).toHaveLength(outputs.length);
  });
  test("calls that never go through (denied ones) don't push out a real call's place", () => {
    const real = { toolUseId: "tu-a", position: 0 };
    const waiting = placeOutputs(placeOutputs(NO_PLACING, [], [real]).placing, [], placesOf(SESSION_LIMITS.maxOpenOutputs * 2, "denied")).placing;
    expect(placeOutputs(waiting, [output], []).placed).toEqual([{ output, position: 0 }]);
  });
  test("what waits is capped", () => {
    const places = placesOf(SESSION_LIMITS.maxWaitingPlaces + 5, "t");
    const outputs = Array.from({ length: SESSION_LIMITS.maxOutputsInFlight + 5 }, (_unused, index) => takenOf(`o${index}`, `u${index}`));
    const { placing } = placeOutputs(NO_PLACING, outputs, places);
    expect([placing.waitingPlaces.length, placing.waitingOutputs.length]).toEqual([SESSION_LIMITS.maxWaitingPlaces, SESSION_LIMITS.maxOutputsInFlight]);
  });
});
