import { afterEach, expect, setSystemTime, test } from "bun:test";
import fc from "fast-check";
import { quietLog } from "../helpers/fakes";
import { LIMITS } from "talos-shared";
import { createConnections, type SocketData } from "../../connections";
import { SERVER_LIMITS } from "../../limits";
import type { MachinesTable } from "../../machines-table";
import { allowBytes, type ByteWindow } from "../../utils/rate-limit";

// Rules: a socket's budget is never exceeded, and one socket's flood never
// uses another socket's budget.

const WINDOW_MS = LIMITS.socketIngressWindowMs;
const MAX_BYTES = LIMITS.maxSocketIngressBytes;
const MAX_MESSAGES = SERVER_LIMITS.maxSocketMessagesPerWindow;
const START_MS = Date.UTC(2026, 0, 1);

afterEach(() => setSystemTime());

test("rule: allowBytes never lets a window hold more than its budget, and a window lasts one window", () => {
  const limit = { windowMs: 1000, maxBytes: 500 };
  const step = fc.record({ waitMs: fc.oneof(fc.nat({ max: 50 }), fc.integer({ min: 990, max: 1010 })), size: fc.nat({ max: 600 }) });
  fc.assert(
    fc.property(fc.array(step, { maxLength: 200 }), (steps) => {
      let nowMs = 0;
      let window: ByteWindow | undefined;
      let allowedInWindow = 0;
      for (const { waitMs, size } of steps) {
        nowMs += waitMs;
        const result = allowBytes(window, nowMs, size, limit);
        const isNewWindow = window === undefined || result.window.startMs !== window.startMs;
        if (isNewWindow) {
          // A new window starts only once the old one is over, and never in the future.
          if (window) expect(result.window.startMs).toBeGreaterThanOrEqual(window.startMs + limit.windowMs);
          expect(result.window.startMs).toBeLessThanOrEqual(nowMs);
          allowedInWindow = 0;
        }
        if (result.isAllowed) allowedInWindow += size;
        expect(allowedInWindow).toBeLessThanOrEqual(limit.maxBytes);
        expect(result.window.bytes).toBe(allowedInWindow);
        // Anything that fits in a fresh window gets through once the window is over.
        if (window && nowMs - window.startMs >= limit.windowMs && size <= limit.maxBytes) expect(result.isAllowed).toBe(true);
        window = result.window;
      }
    }),
    { seed: 20261122, numRuns: 1000 },
  );
});

// A frame that claims to be `size` bytes without building it. The server
// reads its length, then parses String(frame), which isn't JSON, so every
// frame it parses earns exactly one "couldn't be sent" reply.
const fakeFrame = (size: number) => ({ length: size, toString: () => "not json" });

const openPage = (handlers: Record<string, (...args: unknown[]) => void>, personId: string) => {
  const replies: number[] = [];
  const socket = {
    data: { role: "page", personId, displayName: personId, expiresAtMs: Infinity } satisfies SocketData,
    send: () => replies.push(Date.now()),
    close: () => {},
    ping: () => {},
  };
  handlers.open?.(socket);
  return { socket, replies };
};

const runBudget = async (steps: { socket: number; size: number; count: number; waitMs: number }[], quietOnly: boolean) => {
  let nowMs = START_MS;
  setSystemTime(new Date(nowMs));
  const connections = createConnections({ listMachines: async () => [] } as unknown as MachinesTable, quietLog);
  const handlers = connections.websocketHandlers as unknown as Record<string, (...args: unknown[]) => void>;
  const flood = openPage(handlers, "flooder");
  const quiet = openPage(handlers, "quiet");
  await Bun.sleep(0);
  flood.replies.length = 0;
  quiet.replies.length = 0;
  const parsed = { flood: [] as { atMs: number; size: number }[], quiet: [] as { atMs: number; size: number }[] };
  for (const step of steps) {
    nowMs += step.waitMs;
    setSystemTime(new Date(nowMs));
    const isQuiet = step.socket === 0;
    if (!isQuiet && quietOnly) continue;
    const page = isQuiet ? quiet : flood;
    for (let index = 0; index < step.count; index += 1) {
      const repliesBefore = page.replies.length;
      handlers.message?.(page.socket, fakeFrame(step.size));
      if (page.replies.length > repliesBefore) (isQuiet ? parsed.quiet : parsed.flood).push({ atMs: nowMs, size: step.size });
    }
  }
  return parsed;
};

// Over any span one window long, a fixed-window budget lets through at most two windows' worth.
const expectWithinBudget = (parsed: { atMs: number; size: number }[]) => {
  parsed.forEach(({ atMs }) => {
    const span = parsed.filter((message) => message.atMs > atMs - WINDOW_MS && message.atMs <= atMs);
    expect(span.reduce((total, message) => total + message.size, 0)).toBeLessThanOrEqual(2 * MAX_BYTES);
    expect(span.length).toBeLessThanOrEqual(2 * MAX_MESSAGES);
  });
  // And within one instant (always one window), never more than one window's worth.
  const byInstant = Map.groupBy(parsed, (message) => message.atMs);
  byInstant.forEach((messages) => {
    expect(messages.reduce((total, message) => total + message.size, 0)).toBeLessThanOrEqual(MAX_BYTES);
    expect(messages.length).toBeLessThanOrEqual(MAX_MESSAGES);
  });
};

test("rule: a socket never gets more parsed than its budget, and a flood on one socket never costs another", async () => {
  const step = fc.record({
    socket: fc.nat({ max: 3 }), // 0 is the quiet socket, the rest is the flood
    size: fc.oneof(fc.nat({ max: 100 }), fc.integer({ min: MAX_BYTES / 4, max: MAX_BYTES + 1 })),
    count: fc.oneof(fc.constant(1), fc.integer({ min: 1, max: MAX_MESSAGES + 50 })),
    waitMs: fc.oneof(fc.constant(0), fc.nat({ max: 400 }), fc.integer({ min: WINDOW_MS - 2, max: WINDOW_MS + 2 })),
  });
  await fc.assert(
    fc.asyncProperty(fc.array(step, { maxLength: 30 }), async (steps) => {
      const withFlood = await runBudget(steps, false);
      expectWithinBudget(withFlood.flood);
      expectWithinBudget(withFlood.quiet);
      // The quiet socket gets exactly what it would get with no flood at all.
      const alone = await runBudget(steps, true);
      expect(withFlood.quiet).toEqual(alone.quiet);
    }),
    { seed: 20261123, numRuns: 150 },
  );
}, 60_000);
