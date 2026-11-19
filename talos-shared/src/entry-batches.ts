import { type SessionEntry } from "./sessions";
import { LIMITS } from "./limits";

// A session's entries split into batches whose JSON stays under maxBytes, each
// with its size, so no socket message goes over the server's limit. A batch
// also holds at most LIMITS.maxEntriesKept entries, the most a list may carry. Entries
// keep their order. One entry is never split, so an entry bigger than maxBytes
// gets a batch to itself (an entry's text is capped far below any batch size).
export type EntriesBatch = { entries: SessionEntry[]; byteCount: number };

// TextEncoder, not Buffer, so this runs in the page too.
const textEncoder = new TextEncoder();
const byteCountOf = (entry: SessionEntry): number => textEncoder.encode(JSON.stringify(entry)).length;

// Builds local arrays in one pass rather than spreading per entry: a live read
// can hold tens of thousands of entries, and the spread form is quadratic.
export const batchEntriesBySize = (entries: SessionEntry[], maxBytes: number): EntriesBatch[] => {
  const batches: EntriesBatch[] = [];
  for (const entry of entries) {
    const entryBytes = byteCountOf(entry);
    const lastBatch = batches.at(-1);
    const fitsInLastBatch =
      lastBatch !== undefined && lastBatch.byteCount + entryBytes <= maxBytes && lastBatch.entries.length < LIMITS.maxEntriesKept;
    if (fitsInLastBatch) {
      lastBatch.entries.push(entry);
      lastBatch.byteCount += entryBytes;
    } else {
      batches.push({ entries: [entry], byteCount: entryBytes });
    }
  }
  return batches;
};
