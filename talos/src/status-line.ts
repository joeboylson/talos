// One line in the terminal for something that repeats, like a retry: each new
// text replaces the last instead of adding a line. Anything else printed
// first ends it, so the two never share a line. Without a terminal (talos as
// a service, writing to its log), a text is printed once, not every time.
const CLEAR_LINE = "\r\x1b[2K";

export const createStatusLine = (write: (text: string) => void, isTerminal: boolean) => {
  let shownText: string | null = null;
  let isLineOpen = false;
  return {
    show: (text: string): void => {
      if (isTerminal) {
        write(`${CLEAR_LINE}${text}`);
        isLineOpen = true;
      } else if (text !== shownText) {
        write(`${text}\n`);
      }
      shownText = text;
    },
    end: (): void => {
      if (isLineOpen) write("\n");
      isLineOpen = false;
      shownText = null;
    },
  };
};

export type StatusLine = ReturnType<typeof createStatusLine>;
