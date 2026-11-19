import type { SessionEntry } from "talos-shared";

// A session's entries split into batches whose JSON stays under maxBytes, each
// with its size, so no socket message goes over the server's limit. Entries
// keep their order. One entry is never split, so an entry bigger than maxBytes
// gets a batch to itself (an entry's text is capped far below any batch size).
export type EntriesBatch = { entries: SessionEntry[]; byteCount: number };

const byteCountOf = (entry: SessionEntry): number => Buffer.byteLength(JSON.stringify(entry));

// Builds local arrays in one pass rather than spreading per entry: a live read
// can hold tens of thousands of entries, and the spread form is quadratic.
export const batchEntriesBySize = (entries: SessionEntry[], maxBytes: number): EntriesBatch[] => {
  const batches: EntriesBatch[] = [];
  for (const entry of entries) {
    const entryBytes = byteCountOf(entry);
    const lastBatch = batches.at(-1);
    const fitsInLastBatch = lastBatch !== undefined && lastBatch.byteCount + entryBytes <= maxBytes;
    if (fitsInLastBatch) {
      lastBatch.entries.push(entry);
      lastBatch.byteCount += entryBytes;
    } else {
      batches.push({ entries: [entry], byteCount: entryBytes });
    }
  }
  return batches;
};
