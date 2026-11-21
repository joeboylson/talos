// Answers to open outputs, held until the session's turn is over and its screen
// has settled, so an answer is never typed into a permission prompt. Pure: the
// session runner types what these pick.
import { cleanLine, hasCommandMarker } from "../clean";
import type { Refusal } from "../client/runner-protocol";
import { findKind, type Catalog } from "../kinds";
import { SESSION_LIMITS } from "../limits";
import type { Lane } from "./lane";
import type { Outputs } from "./outputs";

export type HeldAnswer = { outputId: string; text: string; heldAtMs: number };

const answerText = (outputId: string, choice: string): string => `Answer to ${outputId}: ${choice}`;

// A click names the output and the choice's position. The choice comes from the
// output's stored, cleaned list, never from the click, and is checked for a
// command again right before it's held.
export const readAnswer = (
  outputs: Outputs,
  held: readonly HeldAnswer[],
  catalog: Catalog,
  outputId: string,
  choice: number,
  nowMs: number,
): HeldAnswer | Refusal => {
  const output = outputs.open.find(({ id }) => id === outputId);
  if (!output || held.some((answer) => answer.outputId === outputId)) return { code: "closed", reason: "That question has closed" };
  const kind = findKind(catalog, output.kind);
  const choicesField = kind?.choicesField;
  const choices = choicesField ? output.fields[choicesField] : undefined;
  const picked = Array.isArray(choices) ? choices[choice] : undefined;
  if (!kind || !choicesField || typeof picked !== "string") return { code: "not-a-choice", reason: "That isn't one of its choices" };
  const allowsCommands = kind.typedFields[choicesField]?.allowCommands === true;
  if (!allowsCommands && hasCommandMarker(cleanLine(picked))) return { code: "not-sendable", reason: "That choice can't be sent" };
  return { outputId, text: answerText(outputId, cleanLine(picked)), heldAtMs: nowMs };
};

// Held answers and a queued ask go out one per settle, oldest first. A draft in
// the input box keeps answers waiting (the queued ask ends on its own then).
export const nextToType = (lane: Lane, held: readonly HeldAnswer[], hasDraft: boolean): "ask" | HeldAnswer | null => {
  const oldest = held[0];
  const isAskFirst = lane.stage === "queued" && (!oldest || lane.askedAtMs <= oldest.heldAtMs);
  if (isAskFirst) return "ask";
  return oldest && !hasDraft ? oldest : null;
};

// Dropped when its question closes, or at the long backstop if the screen never settles.
export const keptHeld = (held: readonly HeldAnswer[], closedIds: readonly string[], nowMs: number): HeldAnswer[] =>
  held.filter((answer) => !closedIds.includes(answer.outputId) && nowMs - answer.heldAtMs <= SESSION_LIMITS.queuedAskTimeoutMs);
