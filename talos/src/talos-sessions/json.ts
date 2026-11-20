// Bad JSON from the other side is expected input, not a bug, so it becomes null.
export const parseJsonOrNull = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
