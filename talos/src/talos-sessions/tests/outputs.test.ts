import { describe, expect, test } from "bun:test";
import { NO_OUTPUTS, NO_PLACING, placeOutputs, readOutputsEvent, stepOutputs, type Outputs, type PendingOutput } from "../lanes/outputs";
import { SESSION_LIMITS } from "../limits";

const pendingOf = (id: string, toolUseId = `tu-${id}`, waits = true): PendingOutput => ({ id, toolUseId, kind: "note", fields: { text: id }, atMs: 1, waits });
const sent = (outputs: Outputs, output: PendingOutput) => stepOutputs(outputs, { type: "sent", output }).outputs;
const through = (outputs: Outputs, output: PendingOutput, id = output.id) =>
  stepOutputs(outputs, { type: "went-through", toolUseId: output.toolUseId, toolInput: { text: "x", id } });
const openIds = (outputs: Outputs) => outputs.open.map(({ id }) => id);

describe("an output opens only if the session saw its id", () => {
  test("it opens when its call goes through with its id", () => {
    const a = pendingOf("a");
    const step = through(sent(NO_OUTPUTS, a), a);
    expect(openIds(step.outputs)).toEqual(["a"]);
    expect(step.opened).toEqual(a);
  });
  test("an input whose id another hook replaced or dropped opens nothing", () => {
    const a = pendingOf("a");
    expect(through(sent(NO_OUTPUTS, a), a, "other").outputs).toEqual(NO_OUTPUTS);
    expect(stepOutputs(sent(NO_OUTPUTS, a), { type: "went-through", toolUseId: a.toolUseId, toolInput: { text: "x" } }).opened).toBeNull();
  });
  test("a failed call opens nothing", () => {
    const a = pendingOf("a");
    expect(stepOutputs(sent(NO_OUTPUTS, a), { type: "failed", toolUseId: a.toolUseId }).outputs).toEqual(NO_OUTPUTS);
  });
  test("a call with no PostToolUse by the next turn is dropped", () => {
    const a = pendingOf("a");
    const next = stepOutputs(sent(NO_OUTPUTS, a), { type: "turn-started" }).outputs;
    expect(next.pending).toEqual([]);
    expect(through(next, a).opened).toBeNull();
  });
  test("one that doesn't wait counts once it goes through, but isn't left open", () => {
    const a = pendingOf("a", "tu-a", false);
    const step = through(sent(NO_OUTPUTS, a), a);
    expect(step.opened).toEqual(a);
    expect(step.outputs.open).toEqual([]);
  });
});

describe("a question lasts one turn", () => {
  const asked = (() => {
    const a = pendingOf("a");
    const inTurn = stepOutputs(NO_OUTPUTS, { type: "turn-started" }).outputs;
    return through(sent(inTurn, a), a).outputs;
  })();
  test("the turn that asked it ending leaves it open", () => {
    expect(openIds(stepOutputs(asked, { type: "turn-ended" }).outputs)).toEqual(["a"]);
  });
  test("the next turn ending closes it, however that turn started", () => {
    const next = stepOutputs(stepOutputs(asked, { type: "turn-ended" }).outputs, { type: "turn-started" }).outputs;
    const step = stepOutputs(next, { type: "turn-ended" });
    expect(step.outputs.open).toEqual([]);
    expect(step.closedIds).toEqual(["a"]);
  });
  test("an answer closes just its own question", () => {
    const b = pendingOf("b");
    const both = through(sent(asked, b), b).outputs;
    expect(openIds(stepOutputs(both, { type: "answered", id: "a" }).outputs)).toEqual(["b"]);
  });
});

describe("open outputs are capped", () => {
  test("past the cap, the oldest closes", () => {
    const outputs = Array.from({ length: SESSION_LIMITS.maxOpenOutputs + 1 }, (_unused, i) => pendingOf(`o${i}`)).reduce(
      (kept, output) => through(sent(kept, output), output).outputs,
      NO_OUTPUTS,
    );
    expect(outputs.open.length).toBe(SESSION_LIMITS.maxOpenOutputs);
    expect(openIds(outputs)[0]).toBe("o1");
  });
});

describe("readOutputsEvent", () => {
  test.each([
    ["a call that went through", { hook_event_name: "PostToolUse", tool_use_id: "t", tool_input: { id: "a" } }, false, { type: "went-through", toolUseId: "t", toolInput: { id: "a" } }],
    ["a call that failed", { hook_event_name: "PostToolUseFailure", tool_use_id: "t" }, false, { type: "failed", toolUseId: "t" }],
    ["a submitted prompt", { hook_event_name: "UserPromptSubmit" }, false, { type: "turn-started" }],
    ["a Stop", { hook_event_name: "Stop" }, false, { type: "turn-ended" }],
    ["a Stop the lane blocked", { hook_event_name: "Stop" }, true, null],
    ["another event", { hook_event_name: "Notification" }, false, null],
  ] as [string, unknown, boolean, unknown][])("%s", (_name, hookDetails, isBlockedStop, expected) => {
    expect(readOutputsEvent(hookDetails, isBlockedStop)).toEqual(expected as ReturnType<typeof readOutputsEvent>);
  });
});

describe("several calls at once", () => {
  const a = pendingOf("a");
  const b = pendingOf("b");
  const both = sent(sent(NO_OUTPUTS, a), b);
  test("each call goes through as itself, and the other stays pending", () => {
    const step = through(both, b);
    expect(openIds(step.outputs)).toEqual(["b"]);
    expect(step.outputs.pending).toEqual([a]);
  });
  test("a failed call drops only its own pending output", () => {
    const afterFailure = stepOutputs(both, { type: "failed", toolUseId: a.toolUseId }).outputs;
    expect(afterFailure.pending).toEqual([b]);
    expect(openIds(through(afterFailure, b).outputs)).toEqual(["b"]);
  });
  test("pending calls are capped, newest kept", () => {
    const many = Array.from({ length: SESSION_LIMITS.maxOpenOutputs + 3 }, (_unused, index) => pendingOf(`p${index}`));
    const outputs = many.reduce(sent, NO_OUTPUTS);
    expect(outputs.pending).toEqual(many.slice(-SESSION_LIMITS.maxOpenOutputs));
  });
  test("a call whose input is missing opens nothing, and a hook with no body is no event", () => {
    expect(stepOutputs(sent(NO_OUTPUTS, a), { type: "went-through", toolUseId: a.toolUseId, toolInput: null }).opened).toBeNull();
    expect(readOutputsEvent(null, false)).toBeNull();
  });
});

describe("an output's place in the conversation", () => {
  const output = pendingOf("a", "tu-a");
  test("an output that went through waits for its call's place, then takes it", () => {
    const first = placeOutputs(NO_PLACING, [output], []);
    expect(first.placed).toEqual([]);
    expect(placeOutputs(first.placing, [], [{ toolUseId: "tu-a", position: 7 }])).toEqual({ placing: NO_PLACING, placed: [{ output, position: 7 }] });
  });
  test("a call's place read first waits for its output", () => {
    const first = placeOutputs(NO_PLACING, [], [{ toolUseId: "tu-a", position: 7 }]);
    expect(placeOutputs(first.placing, [output], []).placed).toEqual([{ output, position: 7 }]);
  });
  test("what waits is capped", () => {
    const places = Array.from({ length: SESSION_LIMITS.maxOpenOutputs + 5 }, (_unused, index) => ({ toolUseId: `t${index}`, position: index }));
    expect(placeOutputs(NO_PLACING, [], places).placing.waitingPlaces.length).toBe(SESSION_LIMITS.maxOpenOutputs);
  });
});
