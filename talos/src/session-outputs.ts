// Talos's kinds of structured output. talos-sessions runs them without knowing
// what they are; talos passes this list in when it starts the session runner.
import { LIMITS, REPORTED_STATUSES } from "talos-shared";
import { PROSE, cleanLine, hasCommandMarker, saysSomething, type OutputKind, type TurnShape } from "./talos-sessions";

const fieldOf = (value: unknown, field: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, field) : undefined;

export const readStatusReport = (toolInput: unknown): { state: string; note: string } | null => {
  const state = fieldOf(toolInput, "state");
  const note = fieldOf(toolInput, "note");
  const reportedState = REPORTED_STATUSES.find((choice) => choice === state);
  const isShortNote = typeof note === "string" && note.length <= LIMITS.maxStatusNoteLength;
  if (!reportedState || !isShortNote) return null;
  return { state: reportedState, note: cleanLine(note) };
};

// A choice is typed as the person's own message when they click it, so it can't
// be a command dressed up as a choice. Lengths are checked before cleaning, which
// only shortens, and the cleaned text must still say something: the shared
// reader turns down an empty question or choice.
export const readDecision = (toolInput: unknown): { question: string; choices: string[] } | null => {
  const question = fieldOf(toolInput, "question");
  const choices = fieldOf(toolInput, "choices");
  const isQuestion = typeof question === "string" && question.length <= LIMITS.maxDecisionQuestionLength;
  const isChoiceList =
    Array.isArray(choices) &&
    choices.length >= LIMITS.minDecisionChoices &&
    choices.length <= LIMITS.maxDecisionChoices &&
    choices.every((choice) => typeof choice === "string" && choice.length <= LIMITS.maxDecisionChoiceLength);
  if (!isQuestion || !isChoiceList) return null;
  const cleanedQuestion = cleanLine(question);
  const cleanedChoices = (choices as string[]).map(cleanLine);
  const hasDuplicates = new Set(cleanedChoices).size !== cleanedChoices.length;
  const isPlainChoice = (choice: string) => saysSomething(choice) && !hasCommandMarker(choice);
  const isUsable = saysSomething(cleanedQuestion) && cleanedChoices.every(isPlainChoice) && !hasDuplicates;
  return isUsable ? { question: cleanedQuestion, choices: cleanedChoices } : null;
};

const STATUS_TOOL_NAME = "report_status";
export const STATUS_KIND: OutputKind = {
  kind: "status",
  toolName: STATUS_TOOL_NAME,
  description:
    `Report THIS session's current status. Call once with your state and one short line. state is one of: ${REPORTED_STATUSES.join(", ")}.`,
  inputSchema: {
    type: "object",
    properties: {
      state: { type: "string", enum: [...REPORTED_STATUSES] },
      note: { type: "string", description: `one short line, at most ${LIMITS.maxStatusNoteLength} characters` },
    },
    required: ["state", "note"],
  },
  readFields: readStatusReport,
  badInputReason: `Call ${STATUS_TOOL_NAME} with state (${REPORTED_STATUSES.join("/")}) and one short line.`,
  acceptedReply: "Status recorded.",
  waits: false,
  requestText:
    `Give a status update on this session by calling ${STATUS_TOOL_NAME} once, with your state and one short line. Do not do anything else.`,
};

const DECISION_TOOL_NAME = "ask_decision";
const choiceCount = `${LIMITS.minDecisionChoices}–${LIMITS.maxDecisionChoices}`;
export const DECISION_KIND: OutputKind = {
  kind: "decision",
  toolName: DECISION_TOOL_NAME,
  description:
    `Ask the person running this session to decide something you can't decide yourself, with ${choiceCount} short choices. ` +
    "They answer with one of your choices or their own words, as their next message. After calling this, end your turn and wait.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: `one question, at most ${LIMITS.maxDecisionQuestionLength} characters` },
      choices: {
        type: "array",
        items: { type: "string", description: `at most ${LIMITS.maxDecisionChoiceLength} characters` },
        minItems: LIMITS.minDecisionChoices,
        maxItems: LIMITS.maxDecisionChoices,
      },
    },
    required: ["question", "choices"],
  },
  readFields: readDecision,
  badInputReason: `Call ${DECISION_TOOL_NAME} with one question and ${choiceCount} short, different choices in plain words (no /, !, # or @).`,
  acceptedReply: "Asked. End your turn now and wait: the answer comes as the person's next message.",
  waits: true,
};

export const OUTPUT_KINDS = [STATUS_KIND, DECISION_KIND];

// A normal turn is prose, and may also ask the person a decision. Status is only
// ever asked for, so a session can't send one on its own.
export const PROSE_TURN: TurnShape = { output: PROSE, optional: [DECISION_KIND.kind] };
