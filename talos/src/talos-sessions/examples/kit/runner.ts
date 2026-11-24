// An example's session runner: the module's, with the example's own kinds, its
// run/ folder as home, sessions allowed only in run/work, and the trust it gave
// put back when it stops. Its watchdog stops it once the example is gone, even
// if the example was killed outright and couldn't stop it itself.
import { join } from "node:path";
import { runSessionRunner, type OutputKind, type TurnShape } from "../../index";

const WATCH_EVERY_MS = 2000;

const isRunning = (processId: number): boolean => {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
};

export const startExampleRunner = async ({ kinds, proseTurn }: { kinds: readonly OutputKind[]; proseTurn: TurnShape }) => {
  const home = process.argv[2];
  const exampleProcessId = Number(process.env.EXAMPLE_PROCESS_ID);
  if (!home || !Number.isInteger(exampleProcessId)) throw new Error("an example's runner.ts is started by its main.ts");
  const work = join(home, "work");
  await runSessionRunner({
    home,
    log: { event: console.log, detail: () => {}, warn: console.warn },
    isAllowedFolder: async (_folderName, path) => path === work,
    kinds,
    proseTurn,
    });
  const watchdog = setInterval(() => {
    if (isRunning(exampleProcessId)) return;
    clearInterval(watchdog);
    // Stopped from inside, the same as a system stop: it ends this runner's own
    // sessions and puts trust back, whatever is on the socket.
    process.kill(process.pid, "SIGTERM");
  }, WATCH_EVERY_MS);
};
