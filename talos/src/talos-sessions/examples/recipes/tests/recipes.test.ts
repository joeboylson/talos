import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRun } from "../../kit/run-example";
import { fitScreen, visibleLength } from "../../kit/screen";
import { readRecording, replay } from "../../kit/recording";
import { BACKSPACE, CTRL_A, ENTER } from "../../kit/view";
import { changedBetween, changedFiles } from "../changes";
import { recipesView } from "../view";

const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
const typed = (keys: string[]) => keys.reduce((state, key) => recipesView.step(state, { type: "key", key }).state, recipesView.initial);

describe("recipes", () => {
  test("typing builds a message, backspace takes a letter off, and Enter sends it", () => {
    const state = typed(["scale it", "!", BACKSPACE]);
    expect(recipesView.step(state, { type: "key", key: ENTER }).actions).toEqual([{ do: "send", text: "scale it" }]);
  });
  test("Ctrl-A attaches to watch the session work", () => {
    expect(recipesView.step(recipesView.initial, { type: "key", key: CTRL_A }).actions).toEqual([{ do: "attach" }]);
  });
  test("the files a run changed: added, removed or edited", () => {
    const before = new Map([["book/a.md", "a"], ["book/b.md", "b"], ["book/c.md", "c"]]);
    const after = new Map([["book/a.md", "a"], ["book/b.md", "B"], ["book/d.md", "d"]]);
    expect(changedBetween(before, after)).toEqual(["book/b.md", "book/c.md", "book/d.md"]);
  });
  test("arrow keys type nothing, and a pasted message keeps its spaces and sends on its Enter", () => {
    expect(typed(["scale", "\x1b[A", "\x1b[D"]).draft).toBe("scale");
    expect(recipesView.step(recipesView.initial, { type: "key", key: "Scale the lasagne.\nThen the dal.\r" }).actions).toEqual([
      { do: "send", text: "Scale the lasagne. Then the dal." },
    ]);
  });
  test("a message that couldn't be sent goes back into the draft", () => {
    const action = { do: "send" as const, text: "scale it" };
    const { state } = recipesView.step(recipesView.initial, { type: "result", action, result: { ok: false, code: "not-sendable", reason: "no" } });
    expect(state.draft).toBe("scale it");
  });
  test("a session that has ended shows as ended", () => {
    const sessions = (list: { sessionName: string; state: "working" }[]) => ({ type: "event" as const, event: { type: "sessions" as const, sessions: list.map((one) => ({ ...one, folderName: "work", asks: {}, openOutputs: [] })) } });
    const working = recipesView.step(recipesView.initial, sessions([{ sessionName: "example", state: "working" }])).state;
    const ended = recipesView.step(working, sessions([])).state;
    expect(plain(recipesView.render(ended, 80))[0]).toContain("ended");
  });
  test("long words wrap instead of being cut, and the end of a long draft shows", () => {
    const entry = { kind: "text" as const, position: 1, entryId: "t1", text: `see ${"x".repeat(200)} and 東京都東京都` };
    const state = { ...recipesView.step(recipesView.initial, { type: "event", event: { type: "session-entries", sessionName: "example", entries: [entry] } }).state, draft: "y".repeat(100) + "END" };
    const lines = plain(fitScreen(recipesView.render(state, 40), 40, 100));
    expect(lines.join("").replace(/\s/g, "")).toContain(`see${"x".repeat(200)}and東京都東京都`);
    expect(lines.every((line) => !line.includes("…"))).toBe(true);
    expect(lines.some((line) => line.includes("END▏"))).toBe(true);
    expect(lines.every((line) => visibleLength(line) <= 40)).toBe(true);
  });
  test("every file a run made counts, folders and links included, and data/ is never changed through a link", () => {
    const folder = mkdtempSync(join(tmpdir(), "talos-recipes-"));
    mkdirSync(join(folder, "data", "book"), { recursive: true });
    writeFileSync(join(folder, "data", "book", "lasagne.md"), "lasagne");
    symlinkSync("lasagne.md", join(folder, "data", "book", "fav.md"));
    const { work } = prepareRun(folder);
    writeFileSync(join(work, "book", "fav.md"), "edited");
    writeFileSync(join(work, "shopping.json"), "{}");
    mkdirSync(join(work, "book", "drafts.md"));
    symlinkSync("gone", join(work, "book", "gone.md"));
    expect(readFileSync(join(folder, "data", "book", "lasagne.md"), "utf8")).toBe("lasagne");
    expect(changedFiles(join(folder, "data"), work)).toEqual(["book/fav.md", "book/gone.md", "shopping.json"]);
    rmSync(folder, { recursive: true, force: true });
  });
  test("the recorded run replays: the message, the session's tools, then its reply", () => {
    const { state, actions } = replay(recipesView, readRecording(readFileSync(join(import.meta.dir, "../recordings/run.jsonl"), "utf8")));
    expect(actions).toEqual([{ do: "send", text: "Scale the lasagne for six servings." }]);
    const kinds = state.entries.map(({ kind }) => kind);
    expect(kinds[0]).toBe("prompt");
    expect(kinds).toContain("tool");
    expect(kinds.at(-1)).toBe("text");
    expect(kinds).not.toContain("output");
    expect(plain(recipesView.render(state, 80)).some((line) => line.startsWith("· "))).toBe(true);
  });
});
