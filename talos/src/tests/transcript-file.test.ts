import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPlainTranscriptFile } from "../transcript-file";

const dir = mkdtempSync(join(tmpdir(), "talos-transcript-"));
const realFile = join(dir, "session.jsonl");
writeFileSync(realFile, "{}\n");
const link = join(dir, "evil.jsonl");
symlinkSync(realFile, link);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("accepts a plain regular file", async () => {
  expect(await isPlainTranscriptFile(realFile)).toBe(true);
});

test("refuses a symlink (even one pointing at a real transcript)", async () => {
  expect(await isPlainTranscriptFile(link)).toBe(false);
});

test("refuses a directory and a missing path", async () => {
  expect(await isPlainTranscriptFile(dir)).toBe(false);
  expect(await isPlainTranscriptFile(join(dir, "nope.jsonl"))).toBe(false);
});
