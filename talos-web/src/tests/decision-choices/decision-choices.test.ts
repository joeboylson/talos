import { expect, test } from "bun:test";
import { numberChoices } from "../../decision-choices";

test("each choice answers with its position", () => {
  const decision = { id: "d1", question: "Which database?", choices: ["Postgres", "SQLite"], atMs: 1 };
  expect(numberChoices(decision)).toEqual([
    { label: "Postgres", choice: 0 },
    { label: "SQLite", choice: 1 },
  ]);
});
