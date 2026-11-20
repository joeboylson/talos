import { expect, test } from "bun:test";
import { markTrusted } from "../claude/claude-trust";

test("marks a new folder trusted and keeps everything else", () => {
  const claudeConfig = { theme: "dark", projects: { "/other": { lastCost: 1 } } };
  expect(markTrusted(claudeConfig, "/code/talos")).toEqual({
    theme: "dark",
    projects: { "/other": { lastCost: 1 }, "/code/talos": { hasTrustDialogAccepted: true } },
  });
});

test("keeps a known folder's other settings", () => {
  expect(markTrusted({ projects: { "/code/talos": { lastCost: 2 } } }, "/code/talos")).toEqual({
    projects: { "/code/talos": { lastCost: 2, hasTrustDialogAccepted: true } },
  });
});

test("an already trusted folder needs no change", () => {
  expect(markTrusted({ projects: { "/code/talos": { hasTrustDialogAccepted: true } } }, "/code/talos")).toBeNull();
});

test("works with no projects yet", () => {
  expect(markTrusted({}, "/code/talos")).toEqual({ projects: { "/code/talos": { hasTrustDialogAccepted: true } } });
});
