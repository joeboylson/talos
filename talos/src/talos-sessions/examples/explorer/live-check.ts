// explorer's live check: a real session answers a question with a chart, and
// the chart's numbers match the same query run straight on shop.db.
// Run: make live-examples LIVE_ONLY=explorer (MODE=record also saves the run).
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { checker, startLiveCheck } from "../kit/live";
import { ENTER } from "../kit/view";
import { explorerView } from "./view";

const { check, done } = checker();
const live = await startLiveCheck(import.meta.dir, explorerView);
try {
  await live.waitFor((state) => state.session === "idle", "the session to be ready", 60_000);
  live.type("Show revenue per month in 2025 as a bar chart.");
  live.type(ENTER);
  await live.waitFor((state) => state.session === "idle" && state.entries.some((entry) => entry.kind === "output"), "an answer with a chart");

  const chart = live.state().entries.find((entry) => entry.kind === "output" && entry.outputKind === "chart");
  check("the answer has a chart", chart !== undefined);
  const fields = chart?.kind === "output" ? chart.fields : {};
  const values = ((fields.series as { values: number[] }[] | undefined)?.[0]?.values ?? []).map(Math.round);
  const shop = new Database(join(live.work, "shop.db"), { readonly: true });
  const expected = shop
    .query(
      "SELECT substr(o.ordered_on, 1, 7) AS month, ROUND(SUM(i.quantity * p.price)) AS revenue FROM orders o JOIN order_items i ON i.order_id = o.id JOIN products p ON p.id = i.product_id GROUP BY month ORDER BY month",
    )
    .all()
    .map((row) => Number((row as { revenue: number }).revenue));
  check("one bar per month", values.length === 12, `${values.length}`);
  check("each bar matches the database, to the nearest whole unit", values.every((value, month) => Math.abs(value - expected[month]!) <= 1), values.join(","));
  check("the session's own text came with it", live.state().entries.some((entry) => entry.kind === "text"));
  check("the chart drew", explorerView.render(live.state(), 100).some((line) => line.includes("█")));
} finally {
  await live.finish();
}
done();
