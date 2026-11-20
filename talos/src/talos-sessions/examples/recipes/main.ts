// recipes: a chat with a session that keeps a small recipe book up to date.
// Run from the repo root: make example EXAMPLE=recipes
import { join } from "node:path";
import { runExample } from "../kit/run-example";
import { changedFiles } from "./changes";
import { recipesView } from "./view";

await runExample(import.meta.dir, recipesView, (home) => {
  const changed = changedFiles(join(import.meta.dir, "data"), join(home, "work"));
  return changed.length > 0 ? ["Changed:", ...changed.map((path) => `  ${path}`)] : ["Nothing changed."];
});
