// The caps talos keeps for itself. Limits both sides check live in
// talos-shared's LIMITS, and the session runner's in talos-sessions.
import { LIMITS } from "talos-shared";

export const TALOS_LIMITS = {
  // A reconnect sends each session's kept entries again, at most this many bytes
  // per millisecond: half the server's per-socket budget, so live traffic still
  // fits and the server drops nothing.
  resendBytesPerMs: LIMITS.maxSocketIngressBytes / LIMITS.socketIngressWindowMs / 2,
} as const;
