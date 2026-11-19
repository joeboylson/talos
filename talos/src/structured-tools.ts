// A structured tool hands the host a typed answer, unlike prose (the session's
// ordinary chat). Each says which turn may call it: "status" only in a status
// turn, where it's the only tool allowed, or "prose" in any ordinary chat turn.
// The MCP server (talos-tools.ts) lists these, and the hooks enforce the turns
// (see status-lane.ts).
import {
  LIMITS,
  REPORTED_STATUSES,
  type ReportedStatus,
  type SessionDecision,
  type SessionStatus,
} from "talos-shared";
import { TALOS_MCP_SERVER_KEY } from "./constants";
import { removeControlCharacters } from "./terminal";

export type StructuredRecord = { kind: "status"; status: SessionStatus } | { kind: "decision"; decision: SessionDecision };

export type StructuredTool = {
  bareName: string;
  // The name Claude Code calls it by, as hooks see it.
  name: string;
  turn: "status" | "prose";
  description: string;
  inputSchema: object;
  readInput: (toolInput: unknown, nowMs: number) => StructuredRecord | null;
  // What the session is told when its input is turned down, and when accepted.
  badInputReason: string;
  acceptedReply: string;
};

const mcpToolName = (bareName: string): string => `mcp__${TALOS_MCP_SERVER_KEY}__${bareName}`;

// Text from a session lands in a shared table row, a card and the logs, so it
// can't carry terminal escapes, line breaks, or characters that hide or reorder
// text: format characters (zero-width, bidi, tags), the Hangul fillers that show
// as blank, and combining marks with nothing before them.
const INVISIBLE_CHARACTERS = /[\p{Cf}\u115f\u1160\u3164\uffa0]/gu;
const LEADING_MARKS = /^\p{M}+/u;
const cleanLine = (text: string): string =>
  removeControlCharacters(text).replace(INVISIBLE_CHARACTERS, "").replace(/\s+/g, " ").trim().replace(LEADING_MARKS, "");

// Shown text must say something a person can read.
const SAYS_SOMETHING = /[\p{L}\p{N}]/u;

// A choice is sent as the person's own message when they click it, and Claude
// Code acts on these in a message: / runs a slash command or skill, ! a shell
// command, # a memory note (at the start), and @ attaches a file, / a skill
// (anywhere after a space). A session could dress one up as a choice.
const COMMAND_MARKER = /(^|\s)[@/!#]/;
const isPlainChoice = (choice: string): boolean => SAYS_SOMETHING.test(choice) && !COMMAND_MARKER.test(choice);

const fieldOf = (value: unknown, field: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, field) : undefined;

export const readStatusReport = (toolInput: unknown): { state: ReportedStatus; note: string } | null => {
  const state = fieldOf(toolInput, "state");
  const note = fieldOf(toolInput, "note");
  const reportedState = REPORTED_STATUSES.find((choice) => choice === state);
  const isShortNote = typeof note === "string" && note.length <= LIMITS.maxStatusNoteLength;
  if (!reportedState || !isShortNote) return null;
  return { state: reportedState, note: cleanLine(note) };
};

// Lengths are checked before cleaning, which only shortens, and the cleaned text
// must still say something: the shared reader turns down an empty question or
// choice, and with it the whole session list.
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
  const isUsable = SAYS_SOMETHING.test(cleanedQuestion) && cleanedChoices.every(isPlainChoice) && !hasDuplicates;
  return isUsable ? { question: cleanedQuestion, choices: cleanedChoices } : null;
};

const STATUS_BARE_NAME = "report_status";
export const STATUS_TOOL: StructuredTool = {
  bareName: STATUS_BARE_NAME,
  name: mcpToolName(STATUS_BARE_NAME),
  turn: "status",
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
  readInput: (toolInput, nowMs) => {
    const report = readStatusReport(toolInput);
    return report ? { kind: "status", status: { ...report, atMs: nowMs } } : null;
  },
  badInputReason: `Call ${STATUS_BARE_NAME} with state (${REPORTED_STATUSES.join("/")}) and one short line.`,
  acceptedReply: "Status recorded.",
};

const DECISION_BARE_NAME = "ask_decision";
const choiceCount = `${LIMITS.minDecisionChoices}–${LIMITS.maxDecisionChoices}`;
export const DECISION_TOOL: StructuredTool = {
  bareName: DECISION_BARE_NAME,
  name: mcpToolName(DECISION_BARE_NAME),
  turn: "prose",
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
  readInput: (toolInput, nowMs) => {
    const decision = readDecision(toolInput);
    return decision ? { kind: "decision", decision: { ...decision, atMs: nowMs } } : null;
  },
  badInputReason: `Call ${DECISION_BARE_NAME} with one question and ${choiceCount} short, different choices in plain words (no /, !, # or @).`,
  acceptedReply: "Asked. End your turn now and wait: the answer comes as the person's next message.",
};

export const STRUCTURED_TOOLS = [STATUS_TOOL, DECISION_TOOL];

export const findStructuredTool = (toolName: string): StructuredTool | undefined =>
  STRUCTURED_TOOLS.find((tool) => tool.name === toolName);
