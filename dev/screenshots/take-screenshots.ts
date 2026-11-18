// Takes every screen of the page, under fixed names, into docs/screenshots/.
// Run with `make screenshots`, which starts and stops the throwaway server.
import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright-core";
import { createDocumentClient } from "../../talos-server/src/dynamo";
import { createSessionToken } from "../../talos-server/src/session";
import { createSignInsTable } from "../../talos-server/src/sign-ins-table";

const SERVER = "http://localhost:7370";
const SOCKET_SERVER = "ws://localhost:7370";
const SESSION_SECRET = "screenshots-only-not-a-real-secret-0000";
const OUT_FOLDER = new URL("../../docs/screenshots/", import.meta.url).pathname;
const DESKTOP = { width: 1280, height: 720 };
const PHONE = { width: 390, height: 844 };
const SETTLE_MS = 800;

// A session only counts while its sign-in is in the database, so the made-up
// admin gets a sign-in there first (in the throwaway server's emulator).
const ADMIN = { personId: "joe", signInId: "github-id:34290408", displayName: "joeboylson" };
await createSignInsTable(createDocumentClient(true), "talos-sign-ins").saveSignIn({ ...ADMIN, linkedAtMs: Date.now() });
const adminSession = createSessionToken(ADMIN, { issuedAtMs: Date.now(), expiresAtMs: Date.now() + 600_000 }, SESSION_SECRET);
const pageHeaders = { Cookie: `talos_session=${adminSession}`, Origin: SERVER, "Content-Type": "application/json" };

const postJson = async (path: string, body: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }) =>
  (await fetch(SERVER + path, { method: "POST", headers, body: JSON.stringify(body) })).json() as Promise<any>;

// Pairs a made-up machine for the admin, the way a real one pairs (with the
// machine's confirmation step skipped: it collects its key straight away).
const pairMachine = async (machineName: string): Promise<string> => {
  const { pairingId, userCode } = await postJson("/api/pair/start", { machineName });
  await postJson("/api/pair/approve", { userCode }, pageHeaders);
  return (await postJson("/api/pair/collect", { pairingId })).machineKey;
};

type MadeUpSession = { sessionName: string; folderName: string; state: string };
type MadeUpEntries = { sessionName: string; entries: unknown[] };

// Connects like talos: reports its folders and sessions, sends session
// entries, and answers pings.
const connectMachine = (
  machineKey: string,
  folders: { folderName: string; path: string }[],
  sessions: MadeUpSession[] = [],
  sessionEntries: MadeUpEntries[] = [],
) =>
  new Promise<WebSocket>((resolve) => {
    const socket = new WebSocket(`${SOCKET_SERVER}/api/sockets/machine`, {
      headers: { Authorization: `Bearer ${machineKey}` },
    } as any);
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === "ping") socket.send(JSON.stringify({ type: "pong", id: message.id }));
    };
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "folders", folders }));
      socket.send(JSON.stringify({ type: "sessions", sessions }));
      sessionEntries.forEach(({ sessionName, entries }) =>
        socket.send(JSON.stringify({ type: "session-entries", sessionName, entries })),
      );
      resolve(socket);
    };
  });

const browser = await chromium.launch();
await mkdir(OUT_FOLDER, { recursive: true });

type Shot = {
  name: string;
  path: string;
  signedIn?: boolean;
  dark?: boolean;
  viewport?: { width: number; height: number };
  before?: (page: Page) => Promise<void>;
};

const takeShot = async ({ name, path, signedIn = true, dark = false, viewport = DESKTOP, before }: Shot) => {
  const context = await browser.newContext({ viewport, colorScheme: dark ? "dark" : "light" });
  if (signedIn) await context.addCookies([{ name: "talos_session", value: adminSession, url: SERVER }]);
  const page = await context.newPage();
  await page.goto(SERVER + path);
  await page.waitForTimeout(SETTLE_MS);
  if (before) await before(page);
  await page.screenshot({ path: `${OUT_FOLDER}${name}.png` });
  await context.close();
  console.log(`  ${name}.png`);
};

const clickButton = (label: string) => async (page: Page) => {
  await page.getByRole("button", { name: label, exact: true }).click();
  await page.waitForTimeout(SETTLE_MS / 2);
};

console.log("screenshots:");
await takeShot({ name: "sign-in", path: "/machines", signedIn: false });
await takeShot({ name: "sign-in-closed", path: "/machines?signIn=closed", signedIn: false });
await takeShot({ name: "machines-empty", path: "/machines" });

const atlasKey = await pairMachine("atlas");
await pairMachine("spark");
const atlas = await connectMachine(
  atlasKey,
  [
    { folderName: "talos", path: "/Users/joe/code/talos" },
    { folderName: "website", path: "/Users/joe/code/website" },
  ],
  [
    { sessionName: "fix-login", folderName: "talos", state: "idle" },
    { sessionName: "new-homepage", folderName: "website", state: "working" },
    { sessionName: "deploy", folderName: "talos", state: "needs-you" },
  ],
  [
    {
      sessionName: "fix-login",
      entries: [
        { kind: "prompt", entryId: "p1", text: "Why does sign-in fail after the session expires?", imageCount: 0 },
        { kind: "tool", entryId: "t1", toolName: "Read", summary: "talos-server/src/auth-routes.ts", outcome: "done" },
        { kind: "tool", entryId: "t2", toolName: "Grep", summary: "signInState", outcome: "done" },
        {
          kind: "text",
          entryId: "x1",
          text: "The page keeps the **old session cookie**, so `/api/auth/me` returns 401 and the page sends you to GitHub, but the callback finds no sign-in state cookie.\n\nI changed the sign-in route to set a fresh state cookie every time. Want me to add a test for it?",
        },
        { kind: "prompt", entryId: "p2", text: "/tdd add the test", imageCount: 1 },
        { kind: "tool", entryId: "t3", toolName: "Edit", summary: "talos-server/src/tests/auth/session.test.ts", outcome: "done" },
        { kind: "tool", entryId: "t4", toolName: "Bash", summary: "Run the server tests", outcome: "failed" },
        { kind: "tool", entryId: "t5", toolName: "Bash", summary: "Run the server tests again", outcome: "running" },
      ],
    },
  ],
);

await takeShot({ name: "machines", path: "/machines", before: clickButton("Ping atlas") });
await takeShot({ name: "machines-dark", path: "/machines", dark: true });
await takeShot({ name: "machines-phone", path: "/machines", viewport: PHONE });
await takeShot({ name: "pair-machine-dialog", path: "/machines", before: clickButton("Pair a machine") });
await takeShot({ name: "rename-machine-dialog", path: "/machines", before: clickButton("Rename atlas") });
await takeShot({ name: "folders", path: "/folders" });
await takeShot({ name: "folders-dark", path: "/folders", dark: true });
await takeShot({ name: "rename-folder-dialog", path: "/folders", before: clickButton("Rename talos") });
await takeShot({ name: "sessions", path: "/sessions" });
await takeShot({ name: "sessions-dark", path: "/sessions", dark: true });
await takeShot({ name: "start-session-dialog", path: "/sessions", before: clickButton("Start a session") });
await takeShot({ name: "session", path: "/sessions/atlas/fix-login" });
await takeShot({ name: "session-dark", path: "/sessions/atlas/fix-login", dark: true });
await takeShot({ name: "settings", path: "/settings" });

atlas.close();
await browser.close();
