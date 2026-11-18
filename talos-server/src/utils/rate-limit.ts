// Whether one more attempt fits in the window, and the attempt times to keep.
// Older times fall out of the window and are dropped.
export const allowAttempt = (
  previousTimesMs: number[],
  nowMs: number,
  { windowMs, maxAttempts }: { windowMs: number; maxAttempts: number },
): { isAllowed: boolean; timesMs: number[] } => {
  const recentTimesMs = previousTimesMs.filter((timeMs) => timeMs > nowMs - windowMs);
  const isAllowed = recentTimesMs.length < maxAttempts;
  return { isAllowed, timesMs: isAllowed ? [...recentTimesMs, nowMs] : recentTimesMs };
};

// The address a request came from. Behind AWS's load balancer every request
// arrives from the balancer, which adds the real address to the end of
// X-Forwarded-For; anything earlier in that header the caller could have
// written themselves, so only the last entry counts.
export const readClientAddress = (forwardedFor: string | null, directAddress: string | undefined): string =>
  forwardedFor?.split(",").at(-1)?.trim() || directAddress || "unknown";
