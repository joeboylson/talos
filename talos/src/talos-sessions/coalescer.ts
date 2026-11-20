// Collapses rapid calls into one run per window (trailing edge): a burst becomes
// a single run that reads the latest state itself, so nothing is lost, only
// coalesced. Used to debounce the session runner's session broadcast so a session can't
// flood the uplink by flapping its own state. `schedule` is injectable for tests.
export const createCoalescer = (
  run: () => void,
  windowMs: number,
  schedule: (fn: () => void, ms: number) => unknown = setTimeout,
): (() => void) => {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    schedule(() => {
      pending = false;
      run();
    }, windowMs);
  };
};
