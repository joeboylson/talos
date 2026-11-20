// receipts: a pile of messy receipts in, a clean list of expenses and totals
// out, with a question when a receipt could go either way.
// Run from the repo root: make example EXAMPLE=receipts
import { runExample } from "../kit/run-example";
import { receiptsView } from "./view";

await runExample(import.meta.dir, receiptsView);
