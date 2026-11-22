// The edges of the rules that a plausible slip in the code would get past the
// other tests: each fails if its rule is broken the way its name says.
import { describe, expect, test } from "bun:test";
import { NO_OUTPUTS, NO_PLACING, placeOutputs, stepOutputs, type Outputs, type PendingOutput } from "../lanes/outputs";
import { keptHeld, nextToType, readAnswer, type HeldAnswer } from "../lanes/held";
import { NO_LANE, stepLane, type Lane } from "../lanes/lane";
import { SESSION_LIMITS } from "../limits";
import { isDraftChangingKeys, isDraftClearingKeys, isTurnChangingKeys } from "../terminal";
import { cleanLine, hasCommandMarker } from "../clean";
import { capDroppedMarkers, mergeSessionEntries, readSessionList, type SessionEntry } from "../shapes";
import { mcpToolName, type Catalog, type OutputKind } from "../kinds";

const keys = (text: string) => new TextEncoder().encode(text);
const pending = (id: string, waits = true): PendingOutput => ({ id, toolUseId: `tu-${id}`, kind: "pick", fields: {}, atMs: 0, waits });
const run = (events: Parameters<typeof stepOutputs>[1][], from: Outputs = NO_OUTPUTS) => events.reduce((o, e) => stepOutputs(o, e).outputs, from);
const open = (id: string) => [{ type: "sent" as const, output: pending(id) }, { type: "went-through" as const, toolUseId: `tu-${id}`, toolInput: { id } }];

const objectOrNull = (value: unknown) => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null);
const kindOf = (kind: string, extra: Partial<OutputKind>): OutputKind => ({ kind, toolName: `send_${kind}`, description: kind, inputSchema: { type: "object" }, readFields: objectOrNull, badInputReason: "bad", typedFields: {}, waits: false, ...extra });
const POLL = kindOf("poll", { requestText: "Send a poll." });
const PICK = kindOf("pick", { typedFields: { choices: { allowCommands: false } }, choicesField: "choices", waits: true });
const CATALOG: Catalog = { kinds: [POLL, PICK], proseTurn: { output: "prose", optional: ["pick"] } };

describe("outputs", () => {
  test("a talos turn's end doesn't close a question (flag must be read from the start)", () => {
    // person turn asks a; person turn ends (turn 1); talos turn starts and ends: a stays open.
    const outputs = run([{ type: "turn-started", isTalosTurn: false }, ...open("a"), { type: "turn-ended" }, { type: "turn-started", isTalosTurn: true }, { type: "turn-ended" }]);
    expect(outputs.open.map(({ id }) => id)).toEqual(["a"]);
  });
  test("a question sent in a talos turn (an answer) isn't closed by the person's next turn's end", () => {
    const outputs = run([{ type: "turn-started", isTalosTurn: true }, ...open("a"), { type: "turn-ended" }, { type: "turn-started", isTalosTurn: false }, { type: "turn-ended" }]);
    expect(outputs.open.map(({ id }) => id)).toEqual(["a"]);
  });
  test("a question asked this turn closes at the end of the person's next turn", () => {
    const outputs = run([{ type: "turn-started", isTalosTurn: false }, ...open("a"), { type: "turn-ended" }, { type: "turn-started", isTalosTurn: false }, { type: "turn-ended" }]);
    expect(outputs.open).toEqual([]);
  });
  test("past maxOutputsInFlight the oldest call is dropped, and up to the cap are kept", () => {
    const sent = Array.from({ length: SESSION_LIMITS.maxOutputsInFlight + 1 }, (_, i) => ({ type: "sent" as const, output: pending(`p${i}`) }));
    const outputs = run(sent);
    expect(outputs.pending.length).toBe(SESSION_LIMITS.maxOutputsInFlight);
    expect(outputs.pending[0].id).toBe("p1");
  });
  test("past maxOpenOutputs the oldest open output closes", () => {
    const events = Array.from({ length: SESSION_LIMITS.maxOpenOutputs + 1 }, (_, i) => open(`q${i}`)).flat();
    const outputs = run(events);
    expect(outputs.open[0].id).toBe("q1");
  });
  test("a call whose id was replaced is dropped, so a later PostToolUse can't open it", () => {
    const outputs = run([{ type: "sent", output: pending("a") }, { type: "went-through", toolUseId: "tu-a", toolInput: { id: "x" } }]);
    expect(outputs.pending).toEqual([]);
  });
  test("past maxWaitingPlaces the oldest place is dropped", () => {
    const places = Array.from({ length: SESSION_LIMITS.maxWaitingPlaces + 1 }, (_, i) => ({ toolUseId: `tu-w${i}`, position: i }));
    expect(placeOutputs(NO_PLACING, [], places).placing.waitingPlaces[0].toolUseId).toBe("tu-w1");
  });
  test("places and outputs each wait under their own cap, and a placed place stops waiting", () => {
    const places = Array.from({ length: SESSION_LIMITS.maxOutputsInFlight + 1 }, (_, i) => ({ toolUseId: `tu-w${i}`, position: i }));
    expect(placeOutputs(NO_PLACING, [], places).placing.waitingPlaces.length).toBe(places.length);
    const outs = Array.from({ length: SESSION_LIMITS.maxOutputsInFlight + 1 }, (_, i) => pending(`w${i}`));
    expect(placeOutputs(NO_PLACING, outs, []).placing.waitingOutputs.length).toBe(SESSION_LIMITS.maxOutputsInFlight);
    const once = placeOutputs(NO_PLACING, [pending("a")], [{ toolUseId: "tu-a", position: 3 }]);
    expect(once.placing).toEqual(NO_PLACING);
  });
});

describe("held", () => {
  const held: HeldAnswer = { outputId: "a", text: "Answer to a: Yes", heldAtMs: 10 };
  const newer: HeldAnswer = { outputId: "b", text: "Answer to b: No", heldAtMs: 20 };
  test("nothing is typed while an asked-for turn is asking", () => {
    expect(nextToType({ stage: "asking", output: "poll", askedAtMs: 0, hasForcedStop: false }, [held], false)).toBeNull();
  });
  test("an ask and an answer at the same moment: the ask goes first", () => {
    expect(nextToType({ stage: "queued", output: "poll", askedAtMs: 10 }, [held], false)).toBe("ask");
  });
  test("answers go oldest first", () => {
    expect(nextToType(NO_LANE, [held, newer], false)).toBe(held);
  });
  test("a held answer is kept up to and at the long backstop", () => {
    expect(keptHeld([held], [], held.heldAtMs + SESSION_LIMITS.queuedAskTimeoutMs)).toEqual([held]);
  });
  test("a typed answer is the cleaned choice", () => {
    const outputs: Outputs = { ...NO_OUTPUTS, open: [{ id: "a", kind: "pick", fields: { choices: ["Ye​s\n"] }, atMs: 0, askedInTurn: 0 }] };
    const answer = readAnswer(outputs, [], CATALOG, "a", 0, 0);
    expect("text" in answer && answer.text).toBe("Answer to a: Yes");
  });
});

describe("lane", () => {
  const asking: Lane = { stage: "asking", output: "poll", askedAtMs: 0, hasForcedStop: false };
  test("answering doesn't restart the long backstop", () => {
    const answered = stepLane(asking, { type: "went-through", output: { ...pending("a"), kind: "poll" } }, 5_000, CATALOG).lane;
    expect(stepLane(answered, { type: "tick" }, SESSION_LIMITS.queuedAskTimeoutMs + 1, CATALOG).lane).toEqual(NO_LANE);
  });
  test("another kind going through doesn't answer the ask", () => {
    expect(stepLane(asking, { type: "went-through", output: pending("a") }, 1, CATALOG).lane.stage).toBe("asking");
  });
  test("a sub-agent's structured call is denied", () => {
    const step = stepLane(NO_LANE, { type: "pre-tool-use", toolName: mcpToolName(PICK.toolName), toolInput: { choices: ["Yes"] }, isSubagent: true, toolUseId: "tu", outputId: "a" }, 0, CATALOG);
    expect(step.hookReply).toContain("deny");
  });
});

describe("terminal", () => {
  test("a line break inside a paste, ended or not, isn't Enter", () => {
    expect(isTurnChangingKeys(keys("\x1b[200~a\rb\x1b[201~"))).toBe(false);
    expect(isTurnChangingKeys(keys("\x1b[200~a\rb"))).toBe(false);
  });
  test("Option-Enter isn't Enter", () => expect(isTurnChangingKeys(keys("\x1b\r"))).toBe(false));
  test("a Ctrl-C byte inside a paste isn't an interrupt", () => expect(isTurnChangingKeys(keys("\x1b[200~a\x03b\x1b[201~"))).toBe(false));
  test("Backspace doesn't make a draft", () => expect(isDraftChangingKeys(keys("\x7f"))).toBe(false));
  test("an empty paste doesn't make a draft", () => expect(isDraftChangingKeys(keys("\x1b[200~\x1b[201~"))).toBe(false));
  test("Ctrl-U and Esc Esc clear the draft", () => {
    expect(isDraftClearingKeys(keys("\x15"))).toBe(true);
    expect(isDraftClearingKeys(keys("\x1b\x1b"))).toBe(true);
  });
  test("Ctrl-U and Esc Esc clear the draft with kitty or modifyOtherKeys encoding on too", () => {
    expect(isDraftClearingKeys(keys("\x1b[117;5u"))).toBe(true);
    expect(isDraftClearingKeys(keys("\x1b[27;5;117~"))).toBe(true);
    expect(isDraftClearingKeys(keys("\x1b[27u\x1b[27u"))).toBe(true);
    expect(isDraftClearingKeys(keys("\x1b[27u"))).toBe(false);
  });
  test("Enter, then the start of an unended paste, leaves a draft", () => expect(isDraftClearingKeys(keys("\r\x1b[200~x"))).toBe(false));
  test("an encoded Ctrl-C pasted as text doesn't clear the draft", () => expect(isDraftClearingKeys(keys("\x1b[200~\x1b[99;5u"))).toBe(false));
  test("an encoded Esc is an interrupt", () => expect(isTurnChangingKeys(keys("\x1b[27u"))).toBe(true));
});

describe("clean", () => {
  test("a combining mark after spaces at the start is stripped", () => expect(cleanLine(" ́a")).toBe("a"));
  test("a Hangul filler is stripped", () => expect(cleanLine("aㅤb")).toBe("ab"));
  test("a skill after a space, and any @, is a command", () => {
    expect(hasCommandMarker("hi /skill")).toBe(true);
    expect(hasCommandMarker("a@b")).toBe(true);
  });
});

describe("shapes", () => {
  const text = (entryId: string, position: number, body = "t"): SessionEntry => ({ kind: "text", entryId, position, text: body });
  const marker = (entryId: string, position: number): SessionEntry => ({ kind: "dropped", entryId, position, droppedKind: "text", reason: "r" });
  test("markers capped before trimming, so dropped markers don't take real entries' places", () => {
    const markers = Array.from({ length: SESSION_LIMITS.maxDroppedKept + 5 }, (_, i) => marker(`m${i}`, i + 1));
    const merged = mergeSessionEntries([text("e0", 0)], markers, SESSION_LIMITS.maxDroppedKept + 1);
    expect(merged.map(({ entryId }) => entryId)[0]).toBe("e0");
  });
  test("past the marker cap the oldest markers go", () => {
    expect(capDroppedMarkers([marker("m1", 1), marker("m2", 2)], 1).map(({ entryId }) => entryId)).toEqual(["m2"]);
  });
  test("entries come back in position order", () => {
    expect(mergeSessionEntries([text("b", 2)], [text("a", 1)], 10).map(({ entryId }) => entryId)).toEqual(["a", "b"]);
  });
  test("a newer copy replaces the kept one", () => {
    expect(mergeSessionEntries([text("a", 1, "old")], [text("a", 1, "new")], 10)).toEqual([text("a", 1, "new")]);
  });
  test("entries whose text is exactly the kept budget are all kept", () => {
    const each = SESSION_LIMITS.maxEntryTextLength;
    const entries = Array.from({ length: SESSION_LIMITS.maxKeptEntryTextLength / each }, (_, i) => text(`b${i}`, i, "x".repeat(each)));
    expect(mergeSessionEntries([], entries, 100).length).toBe(entries.length);
  });
  test("an ask's latest answer over the fields cap is left out when reading", () => {
    const asks = { poll: { state: "answered", atMs: 0, latest: { big: "x".repeat(SESSION_LIMITS.maxOutputFieldsBytes) } } };
    const list = readSessionList([{ sessionName: "s", folderName: "f", state: "idle", asks, openOutputs: [] }]);
    expect(list?.[0].asks.poll).toEqual({ state: "answered", atMs: 0 });
  });
  test("a session's open outputs are capped when read", () => {
    const outputs = Array.from({ length: SESSION_LIMITS.maxOpenOutputs + 1 }, (_, i) => ({ id: `o${i}`, kind: "pick", fields: {}, atMs: 0 }));
    const list = readSessionList([{ sessionName: "s", folderName: "f", state: "idle", asks: {}, openOutputs: outputs }]);
    expect(list?.[0].openOutputs.length).toBe(SESSION_LIMITS.maxOpenOutputs);
  });
});
