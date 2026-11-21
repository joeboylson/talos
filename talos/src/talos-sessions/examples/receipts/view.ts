// receipts: a pile of messy receipts in; a table of expenses, a question when a
// receipt could go either way, and totals out. The session's prose is never
// shown: the program gets data, not text.
import { mergeSessionEntries, type SessionEntry, type SessionSummary } from "../../index";
import { bar, bold, cyan, dim, fit, padTo, yellow } from "../kit/screen";
import { CTRL_A, noActions, type Action, type ExampleView } from "../kit/view";
import { TALLY } from "./kinds";

export const START_MESSAGE = "Sort every file in inbox/.";
const KEPT_ENTRIES = 500;
const BAR_WIDTH = 30;

type OpenOutput = SessionSummary["openOutputs"][number];
type Total = { category: string; currency: string; amount: number };

export type ReceiptsState = {
  session: SessionSummary["state"] | "starting";
  entries: SessionEntry[];
  question: OpenOutput | null;
  tally: Total[] | null;
  // How many expenses the tally last asked for covers (null: none asked, or
  // the ask failed), and that ask's state.
  tallyCovers: number | null;
  tallyAsk: string | null;
  // The question last answered, so its key goes only once.
  answeredId: string | null;
  notice: string;
};

const outputsOf = (entries: SessionEntry[], kind: string) =>
  entries.flatMap((entry) => (entry.kind === "output" && entry.outputKind === kind ? [entry.fields] : []));

// The tally is asked for when the session is idle with no question open (any
// answer has gone in, and the sorting is finished), and again if expenses came
// since, or the last ask failed. Never while one is still being asked.
const tallyAction = (state: ReceiptsState): Action[] => {
  const count = outputsOf(state.entries, "expense").length;
  const isDue = state.session === "idle" && !state.question && state.tallyAsk !== "asking" && count > 0 && count !== state.tallyCovers;
  return isDue ? [{ do: "ask", kind: TALLY.kind }] : [];
};

const withTallyAsk = (state: ReceiptsState): { state: ReceiptsState; actions: Action[] } => {
  const actions = tallyAction(state);
  return { state: actions.length > 0 ? { ...state, tallyCovers: outputsOf(state.entries, "expense").length, tallyAsk: "asking" } : state, actions };
};

const money = (amount: number, currency: string) => `${amount.toFixed(2)} ${currency}`;

const drawTally = (totals: Total[]): string[] => {
  const currencies = [...new Set(totals.map(({ currency }) => currency))];
  return currencies.flatMap((currency) => {
    const group = totals.filter((total) => total.currency === currency);
    const most = Math.max(...group.map(({ amount }) => amount));
    return [dim(currency), ...group.map(({ category, amount }) => `${padTo(category, 10)}${cyan(padTo(bar(amount, most, BAR_WIDTH), BAR_WIDTH))} ${amount.toFixed(2)}`)];
  });
};

export const receiptsView: ExampleView<ReceiptsState> = {
  initial: { session: "starting", entries: [], question: null, tally: null, tallyCovers: null, tallyAsk: null, answeredId: null, notice: "" },
  step: (state, input) => {
    if (input.type === "started") return { state, actions: [{ do: "send", text: START_MESSAGE }] };
    if (input.type === "result") {
      const isFailedAsk = input.action.do === "ask" && !input.result.ok;
      return noActions({ ...state, notice: input.result.ok ? "" : input.result.reason, ...(isFailedAsk && { tallyCovers: null, tallyAsk: null }) });
    }
    if (input.type === "event") {
      const { event } = input;
      if (event.type === "notice") return noActions({ ...state, notice: event.message });
      if (event.type === "session-entries") return withTallyAsk({ ...state, entries: mergeSessionEntries(state.entries, event.entries, KEPT_ENTRIES) });
      const session = event.sessions[0];
      if (!session) return noActions(state);
      const tally = session.asks.tally?.state === "answered" ? ((session.asks.tally.latest?.totals as Total[] | undefined) ?? null) : state.tally;
      const question = session.openOutputs.find(({ kind }) => kind === "question") ?? null;
      const tallyAsk = session.asks.tally?.state ?? state.tallyAsk;
      const tallyCovers = tallyAsk === "no-response" ? null : state.tallyCovers;
      return withTallyAsk({ ...state, session: session.state, question, tally, tallyAsk, tallyCovers });
    }
    const { key } = input;
    if (key === CTRL_A) return { state, actions: [{ do: "attach" }] };
    const choice = Number(key) - 1;
    const choices = (state.question?.fields.choices as string[] | undefined) ?? [];
    const isOpen = state.question && state.question.id !== state.answeredId;
    if (state.question && isOpen && Number.isInteger(choice) && choice >= 0 && choice < choices.length) {
      return { state: { ...state, answeredId: state.question.id }, actions: [{ do: "answer", outputId: state.question.id, choice }] };
    }
    return noActions(state);
  },
  render: (state, columns) => {
    const width = Math.max(columns, 50);
    const expenses = outputsOf(state.entries, "expense");
    const skipped = outputsOf(state.entries, "skipped");
    const row = (fields: Record<string, unknown>) =>
      `${padTo(fit(String(fields.file), 18), 19)}${padTo(String(fields.date), 11)}${padTo(fit(String(fields.shop), 22), 23)}${padTo(money(fields.amount as number, String(fields.currency)), 14)}${fields.category}`;
    const question = state.question;
    return [
      `${bold("receipts")}  ${state.session === "working" ? yellow("◐ sorting") : state.session === "starting" ? dim("○ starting") : "● waiting"}`,
      "",
      ...expenses.map(row),
      ...skipped.map((fields) => dim(fit(`${fields.file}  ✕ ${fields.reason}`, width))),
      ...(question
        ? [
            "",
            yellow(`? ${question.fields.file}: ${question.fields.question}`),
            (question.id === state.answeredId ? dim : (text: string) => text)(`  ${(question.fields.choices as string[]).map((choice, index) => `${bold(String(index + 1))} ${choice}`).join("   ")}`),
          ]
        : []),
      ...(state.tally ? ["", bold("Totals"), ...drawTally(state.tally)] : []),
      "",
      ...(state.notice ? [yellow(fit(state.notice, width))] : []),
      dim(`${question && question.id !== state.answeredId ? "1-9 answer · " : ""}^A attach · ^C quit`),
    ];
  },
};
