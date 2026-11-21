// recipes' session runner: no kinds at all, so a turn is only prose.
import { PROSE } from "../../index";
import { startExampleRunner } from "../kit/runner";

await startExampleRunner({ kinds: [], proseTurn: { output: PROSE, optional: [] } });
