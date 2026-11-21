// Whether one more attempt fits in the window, and the attempt times to keep.
// Older times fall out of the window and are dropped, and so do times from
// after now, left by a clock that jumped back.
export const allowAttempt = (
  previousTimesMs: number[],
  nowMs: number,
  { windowMs, maxAttempts }: { windowMs: number; maxAttempts: number },
): { isAllowed: boolean; timesMs: number[] } => {
  const recentTimesMs = previousTimesMs.filter((timeMs) => timeMs > nowMs - windowMs && timeMs <= nowMs);
  const isAllowed = recentTimesMs.length < maxAttempts;
  return { isAllowed, timesMs: isAllowed ? [...recentTimesMs, nowMs] : recentTimesMs };
};

// Whether this many more message bytes fit in a socket's per-window budget, and
// the new window. Each accepted message is parsed synchronously on the single
// server thread, so this caps how much parse work one connection can force per
// window — a flood of large frames is dropped before it starves other owners.
// A dropped message isn't counted (it was never parsed), so small messages still
// trickle through once a flood has filled the budget with large ones.
export type ByteWindow = { startMs: number; bytes: number };
export const allowBytes = (
  previous: ByteWindow | undefined,
  nowMs: number,
  size: number,
  { windowMs, maxBytes }: { windowMs: number; maxBytes: number },
): { isAllowed: boolean; window: ByteWindow } => {
  // A window that starts after now (the clock jumped back) is over too.
  const elapsedMs = previous === undefined ? -1 : nowMs - previous.startMs;
  const window = previous && elapsedMs >= 0 && elapsedMs < windowMs ? previous : null;
  const startMs = window ? window.startMs : nowMs;
  const usedBytes = window ? window.bytes : 0;
  const isAllowed = usedBytes + size <= maxBytes;
  return { isAllowed, window: { startMs, bytes: isAllowed ? usedBytes + size : usedBytes } };
};

// The address a request came from. Behind AWS's load balancer every request
// arrives from the balancer, which adds the real address to the end of
// X-Forwarded-For; anything earlier in that header the caller could have
// written themselves, so only the last entry counts.
export const readClientAddress = (forwardedFor: string | null, directAddress: string | undefined): string =>
  forwardedFor?.split(",").at(-1)?.trim() || directAddress || "unknown";
