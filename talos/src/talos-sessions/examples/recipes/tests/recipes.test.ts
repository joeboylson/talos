import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readRecording, replay } from "../../kit/recording";
import { BACKSPACE, CTRL_A, ENTER } from "../../kit/view";
import { changedBetween } from "../changes";
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
