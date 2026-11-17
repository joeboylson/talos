// Takes every screen of the page, under fixed names, into docs/screenshots/.
// Run with `make screenshots`, which starts and stops the throwaway server.
import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright-core";
import { createSessionToken } from "../../talos-server/src/session";

const SERVER = "http://localhost:7370";
const SOCKET_SERVER = "ws://localhost:7370";
const SESSION_SECRET = "screenshots-only";
const OUT_FOLDER = new URL("../../docs/screenshots/", import.meta.url).pathname;
const DESKTOP = { width: 1280, height: 720 };
const PHONE = { width: 390, height: 844 };
const SETTLE_MS = 800;

const signInAs = (personId: string, login: string) =>
  createSessionToken({ personId, signInId: `github:${login}`, displayName: login }, Date.now() + 600_000, SESSION_SECRET);
const adminSession = signInAs("joe", "joeboylson");
const pageHeaders = { Cookie: `talos_session=${adminSession}`, Origin: SERVER, "Content-Type": "application/json" };

const postJson = async (path: string, body: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }) =>
  (await fetch(SERVER + path, { method: "POST", headers, body: JSON.stringify(body) })).json() as Promise<any>;

// Pairs a made-up machine for the admin, the way a real one pairs.
const pairMachine = async (machineName: string): Promise<string> => {
  const { pairingId, userCode } = await postJson("/api/pair/start", { machineName });
  await postJson("/api/pair/approve", { userCode }, pageHeaders);
  return (await postJson("/api/pair/poll", { pairingId })).machineKey;
};

// Connects like talos: reports its folders and answers pings.
const connectMachine = (machineKey: string, folders: { folderName: string; path: string }[]) =>
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
const atlas = await connectMachine(atlasKey, [
  { folderName: "talos", path: "/Users/joe/code/talos" },
  { folderName: "website", path: "/Users/joe/code/website" },
]);

await takeShot({ name: "machines", path: "/machines", before: clickButton("Ping atlas") });
await takeShot({ name: "machines-dark", path: "/machines", dark: true });
await takeShot({ name: "machines-phone", path: "/machines", viewport: PHONE });
await takeShot({ name: "pair-machine-dialog", path: "/machines", before: clickButton("Pair a machine") });
await takeShot({ name: "rename-machine-dialog", path: "/machines", before: clickButton("Rename atlas") });
await takeShot({ name: "folders", path: "/folders" });
await takeShot({ name: "folders-dark", path: "/folders", dark: true });
await takeShot({ name: "rename-folder-dialog", path: "/folders", before: clickButton("Rename talos") });
await takeShot({ name: "settings", path: "/settings" });

atlas.close();
await browser.close();
