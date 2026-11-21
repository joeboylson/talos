// receipts' kinds. expense and skipped are sent on their own and don't wait; a
// question waits for the person, who answers by picking one of its choices; a
// tally is only ever asked for.
import { cleanLine, type OutputKind } from "../../index";

export const CATEGORIES = ["travel", "lodging", "meals", "supplies", "software", "events", "personal"] as const;
const MAX_TEXT = 120;

type Fields = Record<string, unknown>;
const field = (input: unknown, name: string): unknown => (typeof input === "object" && input !== null ? Reflect.get(input, name) : undefined);
const shortText = (value: unknown): string | null => (typeof value === "string" && value.trim() && value.length <= MAX_TEXT ? cleanLine(value) : null);
// No receipt is this big; past it the row runs off the screen.
const MAX_AMOUNT = 1e9;
const isAmount = (value: unknown): value is number => typeof value === "number" && value >= 0 && value <= MAX_AMOUNT;
const isCurrency = (value: unknown): value is string => typeof value === "string" && /^[A-Z]{3}$/.test(value);
const isCategory = (value: unknown): value is string => CATEGORIES.some((category) => category === value);
const isDate = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

export const readExpense = (input: unknown): Fields | null => {
  const [file, shop] = [shortText(field(input, "file")), shortText(field(input, "shop"))];
  const [date, amount, currency, category] = ["date", "amount", "currency", "category"].map((name) => field(input, name));
  return file && shop && isDate(date) && isAmount(amount) && isCurrency(currency) && isCategory(category) ? { file, date, shop, amount, currency, category } : null;
};

export const readSkipped = (input: unknown): Fields | null => {
  const [file, reason] = [shortText(field(input, "file")), shortText(field(input, "reason"))];
  return file && reason ? { file, reason } : null;
};

export const readQuestion = (input: unknown): Fields | null => {
  const [file, question] = [shortText(field(input, "file")), shortText(field(input, "question"))];
  const choices = field(input, "choices");
  if (!file || !question || !Array.isArray(choices) || choices.length < 2 || choices.length > 4) return null;
  const cleaned = choices.map(shortText);
  return cleaned.every((choice) => choice !== null) && new Set(cleaned).size === cleaned.length ? { file, question, choices: cleaned } : null;
};

export const readTally = (input: unknown): Fields | null => {
  const totals = field(input, "totals");
  if (!Array.isArray(totals) || totals.length === 0 || totals.length > 30) return null;
  const read = totals.map((total) => {
    const [category, currency, amount] = ["category", "currency", "amount"].map((name) => field(total, name));
    return isCategory(category) && isCurrency(currency) && isAmount(amount) ? { category, currency, amount } : null;
  });
  // One total per category and currency, or the view would draw both.
  const keys = new Set(read.map((total) => total && `${total.category} ${total.currency}`));
  return read.every((total) => total !== null) && keys.size === read.length ? { totals: read } : null;
};

const text = { type: "string", maxLength: MAX_TEXT };
const category = { type: "string", enum: [...CATEGORIES] };

export const EXPENSE: OutputKind = {
  kind: "expense",
  toolName: "send_expense",
  description: "Send one receipt as an expense.",
  inputSchema: {
    type: "object",
    properties: { file: text, date: { type: "string", description: "YYYY-MM-DD" }, shop: text, amount: { type: "number" }, currency: { type: "string", description: "ISO code, like GBP" }, category },
    required: ["file", "date", "shop", "amount", "currency", "category"],
  },
  readFields: readExpense,
  badInputReason: `Call send_expense with file, date (YYYY-MM-DD), shop, amount (a number), currency (like GBP) and a category: ${CATEGORIES.join(", ")}.`,
  typedFields: {},
  waits: false,
};

export const SKIPPED: OutputKind = {
  kind: "skipped",
  toolName: "send_skipped",
  description: "Skip a file that isn't a receipt, or repeats another one.",
  inputSchema: { type: "object", properties: { file: text, reason: text }, required: ["file", "reason"] },
  readFields: readSkipped,
  badInputReason: "Call send_skipped with file and a short reason.",
  typedFields: {},
  waits: false,
};

export const QUESTION: OutputKind = {
  kind: "question",
  toolName: "ask_question",
  description: "Ask the person about a receipt you can't sort alone, then end your turn and wait for the answer.",
  inputSchema: { type: "object", properties: { file: text, question: text, choices: { type: "array", items: text, minItems: 2, maxItems: 4 } }, required: ["file", "question", "choices"] },
  readFields: readQuestion,
  badInputReason: "Call ask_question with file, a question, and 2 to 4 different short choices.",
  typedFields: { choices: { allowCommands: false } },
  choicesField: "choices",
  waits: true,
};

export const TALLY: OutputKind = {
  kind: "tally",
  toolName: "send_tally",
  description: "Send the totals of the expenses you sent, per category and currency.",
  inputSchema: {
    type: "object",
    properties: { totals: { type: "array", items: { type: "object", properties: { category, currency: { type: "string" }, amount: { type: "number" } } } } },
    required: ["totals"],
  },
  readFields: readTally,
  badInputReason: "Call send_tally with totals: one per category and currency, each the sum of the expenses you sent.",
  typedFields: {},
  waits: false,
  requestText: "Send the totals with send_tally: the sum of the expenses you sent, per category and currency.",
};

export const KINDS = [EXPENSE, SKIPPED, QUESTION, TALLY];
// A normal turn may send expenses, skips and questions; a tally is only asked for.
export const PROSE_TURN = { output: "prose", optional: [EXPENSE.kind, SKIPPED.kind, QUESTION.kind] };
