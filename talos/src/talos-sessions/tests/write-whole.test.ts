import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeWhole } from "../runner/write-whole";

// The runner's own small files are swapped in whole, private, with nothing left beside them.
test("a file saved whole replaces the old one, private, with nothing left beside it", () => {
  const folder = mkdtempSync(join(tmpdir(), "talos-whole-"));
  try {
    const file = join(folder, "trust-changes.json");
    writeFileSync(file, "old");
    writeWhole(file, "[1,2]");
    expect(readFileSync(file, "utf8")).toBe("[1,2]");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(folder)).toEqual(["trust-changes.json"]);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
