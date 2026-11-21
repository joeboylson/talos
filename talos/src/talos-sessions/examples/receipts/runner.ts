// receipts' session runner: its own kinds, started by main.ts.
import { startExampleRunner } from "../kit/runner";
import { KINDS, PROSE_TURN } from "./kinds";

await startExampleRunner({ kinds: KINDS, proseTurn: PROSE_TURN });
