// receipts' live check: a real session sorts the inbox, asks about the dinner,
// gets "Business" by id, and the expenses and tally match answers.json.
// Run: make live-examples LIVE_ONLY=receipts (MODE=record also saves the run).
import { checker, startLiveCheck } from "../kit/live";
import answers from "./answers.json";
import { receiptsView } from "./view";

type Expected = { amount: number; currency: string; category: string | Record<string, string> };
const { check, done } = checker();
const live = await startLiveCheck(import.meta.dir, receiptsView);
const outputs = (kind: string) =>
  live.state().entries.flatMap((entry) => (entry.kind === "output" && entry.outputKind === kind ? [entry.fields] : []));

try {
  await live.waitFor((state) => state.question !== null, "the question about the dinner");
  const question = live.state().question!;
  check("the question is about the unclear receipt", question.fields.file === answers.unclear, String(question.fields.file));
  const business = (question.fields.choices as string[]).findIndex((choice) => /business/i.test(choice));
  live.type(String(business + 1));
  await live.waitFor((state) => state.tally !== null, "the tally");

  const expenses = outputs("expense");
  const skipped = outputs("skipped").map(({ file }) => String(file));
  const sentFiles = [...expenses.map(({ file }) => String(file)), ...skipped];
  const expected = answers.expenses as Record<string, Expected>;
  check("every file is sent exactly once", new Set(sentFiles).size === sentFiles.length && sentFiles.length === 11, sentFiles.join(","));
  check("the newsletter is skipped", skipped.includes("09-newsletter.txt"));
  check("one of the duplicate pair is skipped", answers.duplicates.every((pair) => pair.filter((file) => skipped.includes(file)).length === 1));
  const wrong = Object.entries(expected).filter(([file, want]) => {
    const got = expenses.find((fields) => fields.file === file) ?? expenses.find((fields) => String(fields.file).startsWith("10-") && file === "04-paper.txt");
    const category = typeof want.category === "string" ? want.category : want.category.Business;
    return !got || Math.abs((got.amount as number) - want.amount) > 0.005 || got.currency !== want.currency || got.category !== category;
  });
  check("amounts, currencies and categories match the answers", wrong.length === 0, wrong.map(([file]) => file).join(","));

  const sums = new Map<string, number>();
  expenses.forEach(({ category, currency, amount }) => sums.set(`${category} ${currency}`, (sums.get(`${category} ${currency}`) ?? 0) + (amount as number)));
  const tally = live.state().tally ?? [];
  check(
    "the tally matches the expenses sent, per category and currency, to the cent",
    tally.length === sums.size && tally.every(({ category, currency, amount }) => Math.abs((sums.get(`${category} ${currency}`) ?? -1) - amount) < 0.005),
    JSON.stringify(tally),
  );
  check("no prose is shown", !receiptsView.render(live.state(), 100).some((line) => live.state().entries.some((entry) => entry.kind === "text" && line.includes(entry.text.slice(0, 20)))));
} finally {
  await live.finish();
}
done();
