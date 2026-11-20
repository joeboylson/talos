// The session runner's start-up: talos spawns this file as its own background
// program (see RUNNER_SCRIPT).
import { runSessionRunner } from "./talos-sessions";

await runSessionRunner();
