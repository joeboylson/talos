import { describe, expect, test } from "bun:test";
import { readRecording, recordEvent, replay, saveRecording, toInput, type RecordedLine } from "../recording";
import type { ExampleView } from "../view";

const ID = "0f4c6a52-1b2d-4e8f-9a3b-5c6d7e8f9a0b";
const sessions: RecordedLine = recordEvent({
  type: "sessions",
  sessions: [{ sessionName: "example", folderName: "work", state: "idle", asks: {}, openOutputs: [{ id: ID, kind: "question", fields: { file: "/tmp/run/work/a.txt" }, atMs: 1795200000000 }] }],
});

describe("recordings", () => {
  test("ids, times and the run folder become stable placeholders, the same id the same way", () => {
    const saved = saveRecording([sessions, { type: "result", action: { do: "answer", outputId: ID, choice: 0 }, result: { ok: true } }], "/tmp/run");
    expect(saved).not.toContain(ID);
    expect(saved).not.toContain("1795200000000");
    expect(saved).not.toContain("/tmp/run");
    const [event, result] = readRecording(saved);
    expect(event.type === "event" && event.line).toContain('"id":"id-1"');
    expect(result).toMatchObject({ type: "result", action: { outputId: "id-1" } });
  });
  test("a saved recording reads back through the module's own reader", () => {
    const [line] = readRecording(saveRecording([sessions], "/tmp/run"));
    expect(toInput(line!, 0)).toMatchObject({ type: "event", event: { type: "sessions" } });
  });
  test("an event the module can't read fails the replay, asking for a re-recording", () => {
    expect(() => toInput({ type: "event", line: '{"type":"sessions","sessions":"nope"}' }, 4)).toThrow("re-record");
    expect(() => readRecording('{"type":"mystery"}')).toThrow("re-record");
  });
  test("a replay feeds a view every input in order, starting with started", () => {
    const counter: ExampleView<string[]> = {
      initial: [],
      step: (seen, input) => ({ state: [...seen, input.type], actions: input.type === "key" ? [{ do: "send", text: input.key }] : [] }),
      render: (seen) => seen,
    };
    const played = replay(counter, [sessions, { type: "key", key: "x" }]);
    expect(played.state).toEqual(["started", "event", "key"]);
    expect(played.actions).toEqual([{ do: "send", text: "x" }]);
  });
});
