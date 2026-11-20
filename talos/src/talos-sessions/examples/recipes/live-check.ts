// recipes' live check: asked to scale the lasagne for six, a real session edits
// that one file, and nothing else in the book changes.
// Run: make live-examples LIVE_ONLY=recipes (MODE=record also saves the run).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checker, startLiveCheck } from "../kit/live";
import { ENTER } from "../kit/view";
import { changedFiles } from "./changes";
import { recipesView } from "./view";

const { check, done } = checker();
const live = await startLiveCheck(import.meta.dir, recipesView);
try {
  await live.waitFor((state) => state.session === "idle", "the session to be ready", 60_000);
  live.type("Scale the lasagne for six servings.");
  live.type(ENTER);
  await live.waitFor(
    (state) => state.session === "idle" && state.entries.at(-1)?.kind === "text" && state.entries.some((entry) => entry.kind === "prompt"),
    "the session's reply",
  );
  const changed = changedFiles(join(import.meta.dir, "data"), live.work);
  const lasagne = readFileSync(join(live.work, "book", "lasagne.md"), "utf8");
  check("only the lasagne changed", changed.length === 1 && changed[0] === join("book", "lasagne.md"), changed.join(","));
  check("it says it serves six", /serves\s+6/i.test(lasagne));
  check("the amounts went up by half", lasagne.includes("750 g beef mince") && lasagne.includes("750 ml milk"));
  check("the session replied in words", live.state().entries.some((entry) => entry.kind === "text"));
  check("no fixed-field answers: a prose-only session", !live.state().entries.some((entry) => entry.kind === "output"));
} finally {
  await live.finish();
}
done();
