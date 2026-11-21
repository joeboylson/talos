// The fake-runner tests' session runner: a made-up note kind (sent on its own,
// doesn't wait), question kind (waits, with choices) and status kind (asked
// for), and the fake Claude.
import { runSessionRunner, type OutputKind } from "../../index";

const home = process.argv[2];
if (!home) throw new Error("fake-runner.ts needs its home folder as its argument");

const textField = (field: string) => (input: unknown) => {
  const value = typeof input === "object" && input !== null ? Reflect.get(input, field) : undefined;
  return typeof value === "string" ? value : null;
};

const NOTE: OutputKind = {
  kind: "note",
  toolName: "send_note",
  description: "send a note",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  readFields: (input) => {
    const text = textField("text")(input);
    return text === null ? null : { text };
  },
  badInputReason: "send_note needs text",
  typedFields: {},
  waits: false,
};

const QUESTION: OutputKind = {
  kind: "question",
  toolName: "ask_question",
  description: "ask a question",
  inputSchema: { type: "object", properties: { question: { type: "string" }, choices: { type: "array", items: { type: "string" } } } },
  readFields: (input) => {
    const question = textField("question")(input);
    const choices = typeof input === "object" && input !== null ? Reflect.get(input, "choices") : undefined;
    const isChoices = Array.isArray(choices) && choices.every((choice) => typeof choice === "string");
    return question !== null && isChoices ? { question, choices } : null;
  },
  badInputReason: "ask_question needs a question and choices",
  typedFields: { choices: { allowCommands: false } },
  choicesField: "choices",
  waits: true,
};

// Asked for, never sent on its own.
const STATUS: OutputKind = {
  kind: "status",
  toolName: "send_status",
  description: "send a status",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  readFields: (input) => {
    const text = textField("text")(input);
    return text === null ? null : { text };
  },
  badInputReason: "send_status needs text",
  typedFields: {},
  waits: false,
  requestText: "please send status",
};

await runSessionRunner({
  home,
  log: { event: () => {}, detail: () => {}, warn: console.warn },
  isAllowedFolder: async () => true,
  kinds: [NOTE, QUESTION, STATUS],
  proseTurn: { output: "prose", optional: ["note", "question"] },
  claudeCommand: [process.execPath, new URL("./fake-claude.ts", import.meta.url).pathname],
  claudeConfigFile: `${home}/claude.json`,
});
