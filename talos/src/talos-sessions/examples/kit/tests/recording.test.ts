import { describe, expect, test } from "bun:test";
import { placeholdersFor, readRecording, recordEvent, replay, saveRecording, toInput, type RecordedLine } from "../recording";
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
  test("an event in an older shape fails the replay instead of being read as less", () => {
    const stale = sessions.type === "event" ? sessions.line.replace('"state":"idle"', '"state":"waiting"') : "";
    expect(() => toInput({ type: "event", line: stale }, 0)).toThrow("re-record");
    const renamed = sessions.type === "event" ? sessions.line.replace('"atMs"', '"at"') : "";
    expect(() => toInput({ type: "event", line: renamed }, 0)).toThrow("re-record");
  });
  test("a line cut short asks for a re-recording", () => {
    expect(() => readRecording('{"type":"key","ke')).toThrow("re-record");
  });
  test("the run folder is replaced only as a whole path, and tool ids get placeholders too", () => {
    const placeholders = placeholdersFor("/x/explorer/run");
    expect(placeholders("/x/explorer/run/work /x/explorer/runner.ts /x/explorer/run")).toBe("<run>/work /x/explorer/runner.ts <run>");
    expect(placeholders("toolu_017PZcNX5E9YZFCMuNxGPNkW then toolu_017PZcNX5E9YZFCMuNxGPNkW")).toBe("id-1 then id-1");
  });
  test("a recorded result for something the view no longer does fails the replay", () => {
    const sender: ExampleView<null> = { initial: null, step: (state, input) => ({ state, actions: input.type === "started" ? [{ do: "send", text: "now" }] : [] }), render: () => [] };
    const result = (text: string): RecordedLine => ({ type: "result", action: { do: "send", text }, result: { ok: true } });
    expect(replay(sender, [result("now")]).actions).toEqual([{ do: "send", text: "now" }]);
    expect(() => replay(sender, [result("then")])).toThrow("re-record");
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
