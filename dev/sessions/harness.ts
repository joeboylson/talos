// Shared pieces for the live session checks: a session runner in a throwaway
// talos folder, real Claude Code sessions in throwaway work folders, and a way
// to act as a session (with its own hook token) to try what a hostile one could.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionOf, statusOf, type SessionSummary } from "../../talos-shared/src";

export const ROOT = new URL("../../talos/src/", import.meta.url).pathname;
export const HOME = mkdtempSync(join(tmpdir(), "talos-live-"));
process.env.TALOS_HOME = HOME;

const sessions = await import(`${ROOT}talos-sessions/index.ts`);
const constants = await import(`${ROOT}constants.ts`);
const hookClient = await import(`${ROOT}talos-sessions/client/hook-client.ts`);
const runnerConstants = await import(`${ROOT}talos-sessions/constants.ts`);
export const { RUNNER_ROUTES, sessionRoute } = sessions;
export const postToRunner = (route: string, body: unknown): Promise<Response> => sessions.postToRunner(HOME, route, body);
export const runnerFetch = (route: string, init?: RequestInit): Promise<Response> => sessions.runnerFetch(HOME, route, init);
export const isRunnerRunning = (): Promise<boolean> => sessions.isRunnerRunning(HOME);
export const RUNNER_HOOKS_SOCKET: string = runnerConstants.homePaths(HOME).hooksSocket;
export const HOOK_SCRIPT: string = runnerConstants.HOOK_SCRIPT;

// Each check gets its own folder; extra Claude Code settings go in its .claude.
export const makeFolder = (folderName: string, projectSettings?: object): string => {
  const path = join(HOME, "work", folderName);
  mkdirSync(join(path, ".claude"), { recursive: true });
  if (projectSettings) writeFileSync(join(path, ".claude", "settings.json"), JSON.stringify(projectSettings));
  return path;
};

const folders: { folderName: string; path: string }[] = [];
export const allowFolder = (folderName: string, path: string) => {
  folders.push({ folderName, path });
  writeFileSync(join(HOME, "folders.json"), JSON.stringify(folders));
};

export const startRunner = () => sessions.ensureRunnerRunning(HOME, constants.RUNNER_SCRIPT);
export const stopRunner = () => postToRunner(RUNNER_ROUTES.stop, {}).catch(() => {});

export const rawSession = async (sessionName: string): Promise<SessionSummary | undefined> =>
  ((await (await runnerFetch(RUNNER_ROUTES.sessions)).json()) as SessionSummary[]).find((session) => session.sessionName === sessionName);

export const sessionView = async (sessionName: string) => {
  const session = await rawSession(sessionName);
  return session && { ...session, status: statusOf(session), decision: openDecisionOf(session) };
};

export type SessionView = NonNullable<Awaited<ReturnType<typeof sessionView>>>;

export const waitFor = async (sessionName: string, check: (session: SessionView) => boolean, ms = 120_000): Promise<SessionView | null> => {
  const giveUpAt = Date.now() + ms;
  while (Date.now() < giveUpAt) {
    const session = await sessionView(sessionName);
    if (session && check(session)) return session;
    await Bun.sleep(500);
  }
  return null;
};

export const startSession = async (sessionName: string, folderName: string, path: string) => {
  const response = await postToRunner(RUNNER_ROUTES.sessions, { sessionName, folderName, path });
  if (!response.ok) throw new Error(`couldn't start ${sessionName}: ${await response.text()}`);
  return waitFor(sessionName, (session) => session.state === "idle", 60_000);
};

export const send = (sessionName: string, text: string) => postToRunner(sessionRoute(sessionName, "send"), { text });
// Keys as an attached terminal sends them.
export const typeKeys = (sessionName: string, keys: string) => runnerFetch(sessionRoute(sessionName, "input"), { method: "POST", body: keys });
export const ask = (sessionName: string, kind: string) => postToRunner(sessionRoute(sessionName, "ask"), { kind });
export const answer = (sessionName: string, outputId: string, choice: number) =>
  postToRunner(sessionRoute(sessionName, "answer"), { outputId, choice });
export const stopSession = (sessionName: string) => postToRunner(sessionRoute(sessionName, "stop"), {});

// The session's screen as text, for checking what it showed.
export const screen = async (sessionName: string): Promise<string> => {
  const response = await runnerFetch(sessionRoute(sessionName, "output"), { timeout: false } as RequestInit);
  const reader = response.body!.getReader();
  setTimeout(() => reader.cancel(), 1000);
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
    text += new TextDecoder().decode(value);
  }
};

// What the session itself saw: Claude Code's saved conversation for the folder,
// which holds each tool's reply (the screen folds those away).
export const savedConversation = async (folderPath: string): Promise<string> => {
  const folder = join(homedir(), ".claude", "projects", realpathSync(folderPath).replace(/[^a-zA-Z0-9]/g, "-"));
  const files = existsSync(folder) ? readdirSync(folder).filter((file) => file.endsWith(".jsonl")) : [];
  return (await Promise.all(files.map((file) => Bun.file(join(folder, file)).text()))).join("\n");
};

// A session's own hook token, read from its Claude Code process: what a hostile
// session (or anything it runs) has.
export const tokenOf = async (sessionName: string): Promise<string> => {
  const listing = await new Response(Bun.spawn(["ps", "-AEww", "-o", "command"]).stdout).text();
  const line = listing.split("\n").find((row) => row.includes(`TALOS_SESSION_NAME=${sessionName} `) && row.includes(HOME));
  const token = line?.match(/TALOS_HOOK_TOKEN=(\S+)/)?.[1];
  if (!token) throw new Error(`no token found for ${sessionName}`);
  return token;
};

// Sends a hook as the session would, and returns the runner's answer.
export const forgeHook = (sessionName: string, token: string, details: object) =>
  hookClient.askRunner(RUNNER_HOOKS_SOCKET, { sessionName, token, details: JSON.stringify(details) });

// Runs the real hook script, as Claude Code does, and returns what it prints.
export const runHookScript = async (env: Record<string, string>, details: object): Promise<string> => {
  const child = Bun.spawn([process.execPath, HOOK_SCRIPT], { env: { ...process.env, ...env }, stdin: "pipe", stdout: "pipe" });
  child.stdin.write(JSON.stringify(details));
  child.stdin.end();
  return new Response(child.stdout).text();
};

const results: { name: string; passed: boolean; detail: string }[] = [];
export const check = (name: string, passed: boolean, detail = "") => {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
export const finish = async () => {
  await stopRunner();
  const failed = results.filter(({ passed }) => !passed);
  console.log(`\n${results.length - failed.length}/${results.length} passed; talos folder ${HOME}`);
  process.exit(failed.length > 0 ? 1 : 0);
};
