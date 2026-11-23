// receipts: a pile of messy receipts in; a table of expenses, a question when a
// receipt could go either way, and totals out. The session's prose is never
// shown: the program gets data, not text.
import { mergeSessionEntries, type SessionEntry, type SessionSummary } from "../../index";
import { bar, bold, cyan, dim, fit, padTo, wrapText, yellow } from "../kit/screen";
import { CTRL_A, noActions, type Action, type ExampleView } from "../kit/view";
import { TALLY } from "./kinds";

export const START_MESSAGE = "Sort every file in inbox/.";
const KEPT_ENTRIES = 500;
const MAX_BAR_WIDTH = 30;

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

// Each amount before its bar, and the bar sized to what's left, so a narrow
// screen shortens bars, never amounts.
const drawTally = (totals: Total[], width: number): string[] => {
  const currencies = [...new Set(totals.map(({ currency }) => currency))];
  const amountWidth = Math.max(...totals.map(({ amount }) => amount.toFixed(2).length));
  const barWidth = Math.max(Math.min(width - 10 - amountWidth - 1, MAX_BAR_WIDTH), 1);
  return currencies.flatMap((currency) => {
    const group = totals.filter((total) => total.currency === currency);
    const most = Math.max(...group.map(({ amount }) => amount));
    return [dim(currency), ...group.map(({ category, amount }) => `${padTo(category, 10)}${amount.toFixed(2).padStart(amountWidth)} ${cyan(bar(amount, most, barWidth))}`)];
  });
};

export const receiptsView: ExampleView<ReceiptsState> = {
  initial: { session: "starting", entries: [], question: null, tally: null, tallyCovers: null, tallyAsk: null, answeredId: null, notice: "" },
  step: (state, input) => {
    if (input.type === "started") return { state, actions: [{ do: "send", text: START_MESSAGE }] };
    if (input.type === "result") {
      const isFailedAsk = input.action.do === "ask" && !input.result.ok;
      // A refused answer didn't go, so the question can be answered again.
      const isFailedAnswer = input.action.do === "answer" && !input.result.ok;
      return noActions({
        ...state,
        notice: input.result.ok ? "" : input.result.reason,
        ...(isFailedAsk && { tallyCovers: null, tallyAsk: null }),
        ...(isFailedAnswer && { answeredId: null }),
      });
    }
    if (input.type === "event") {
      const { event } = input;
      if (event.type === "notice") return noActions({ ...state, notice: event.message });
      if (event.type === "message-returned") return noActions(state);
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
    const width = Math.max(columns, 1);
    const expenses = outputsOf(state.entries, "expense");
    const skipped = outputsOf(state.entries, "skipped");
    // The amount and category first: a narrow screen cuts the end of a line.
    const row = (fields: Record<string, unknown>) =>
      `${padTo(money(fields.amount as number, String(fields.currency)), 14)}${padTo(String(fields.category), 15)}${padTo(String(fields.date), 11)}${padTo(fit(String(fields.shop), 22), 23)}${fit(String(fields.file), 18)}`;
    const question = state.question;
    return [
      `${bold("receipts")}  ${state.session === "working" ? yellow("◐ sorting") : state.session === "starting" ? dim("○ starting") : "● waiting"}`,
      "",
      ...expenses.map(row),
      ...skipped.map((fields) => dim(fit(`${fields.file}  ✕ ${fields.reason}`, width))),
      ...(question
        ? [
            "",
            ...wrapText(`? ${question.fields.file}: ${question.fields.question}`, width).map(yellow),
            // A choice a line, wrapped, so every one can be read before it's picked.
            ...(question.fields.choices as string[]).flatMap((choice, index) =>
              wrapText(choice, Math.max(width - 4, 1)).map((line, at) =>
                (question.id === state.answeredId ? dim : (text: string) => text)(at === 0 ? `  ${bold(String(index + 1))} ${line}` : `    ${line}`),
              ),
            ),
          ]
        : []),
      ...(state.tally ? ["", bold("Totals"), ...drawTally(state.tally, width)] : []),
      "",
      ...(state.notice ? [yellow(fit(state.notice, width))] : []),
      dim(`${question && question.id !== state.answeredId ? "1-9 answer · " : ""}^A attach · ^C quit`),
    ];
  },
};
