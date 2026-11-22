// Drawing in the terminal with its own colours (the basic ANSI ones, which each
// terminal's theme picks), so an example looks right in light and dark.
// No colour where it's asked not to be (NO_COLOR) or the terminal can't (dumb).
const hasColour = (): boolean => !process.env.NO_COLOR && process.env.TERM !== "dumb";
const wrap = (code: number, reset: number) => (text: string): string => (hasColour() ? `\x1b[${code}m${text}\x1b[${reset}m` : text);

export const dim = wrap(2, 22);
export const bold = wrap(1, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const cyan = wrap(36, 39);

// How many cells a line takes: colours take none, wide characters (like CJK) two.
export const visibleLength = (text: string): number => Bun.stringWidth(text);

export const padTo = (text: string, width: number): string => text + " ".repeat(Math.max(width - visibleLength(text), 0));

const COLOUR_AT_START = /^\x1b\[[0-9;]*m/;
const RESET = "\x1b[0m";

const graphemes = new Intl.Segmenter();

// Cut to width cells, with … where it was cut. Colours are kept whole and take
// no room, and a cut line ends with a reset, so a colour can't be left open.
export const fit = (text: string, width: number): string => {
  if (visibleLength(text) <= width) return text;
  const cut = (rest: string, room: number, kept: string): string => {
    const colour = COLOUR_AT_START.exec(rest)?.[0];
    if (colour) return cut(rest.slice(colour.length), room, kept + colour);
    const character = [...graphemes.segment(rest)][0]?.segment;
    if (character === undefined || visibleLength(character) > room) return kept;
    return cut(rest.slice(character.length), room - visibleLength(character), kept + character);
  };
  return `${cut(text, Math.max(width - 1, 0), "")}${RESET}…`;
};

// What a view draws, as the terminal shows it: no line wider than the terminal
// (a wrapped line would scroll the top off), and the newest lines that fit, so
// the conversation scrolls up as it grows.
export const fitScreen = (lines: readonly string[], columns: number, rows: number): string[] =>
  lines.slice(-rows).map((line) => fit(line, columns));

// A bar of █ for value out of most, width cells wide at most, with ▌ for a half.
export const bar = (value: number, most: number, width: number): string => {
  if (most <= 0 || value <= 0) return "";
  const halves = Math.round((value / most) * width * 2);
  return "█".repeat(Math.floor(halves / 2)) + (halves % 2 ? "▌" : "");
};

// A word wider than the line is split, by cells, so nothing is cut off.
const splitWord = (word: string, width: number): string[] =>
  [...word].reduce<string[]>((parts, character) => {
    const last = parts.at(-1);
    return last !== undefined && visibleLength(last + character) <= width ? [...parts.slice(0, -1), last + character] : [...parts, character];
  }, []);

// Wraps plain text to the width in cells, keeping its own line breaks.
// A tab is drawn as spaces: its width depends on where it lands, and a
// terminal's is more than the zero cells it measures as.
export const wrapText = (text: string, width: number): string[] =>
  text.replace(/\t/g, "  ").split("\n").flatMap((paragraph) =>
    paragraph
      .split(" ")
      .flatMap((word) => (visibleLength(word) > width ? splitWord(word, Math.max(width, 1)) : [word]))
      .reduce<string[]>((lines, word) => {
        const last = lines.at(-1);
        if (last !== undefined && visibleLength(last ? `${last} ${word}` : word) <= width) return [...lines.slice(0, -1), last ? `${last} ${word}` : word];
        return [...lines, word];
      }, []),
  );

// The end of a line that's too long, so what's being typed, and the cursor, show.
// Walked back from the end a character at a time, so a long paste stays quick.
export const lastCells = (text: string, width: number): string => {
  const characters = [...graphemes.segment(text)].map(({ segment }) => segment);
  const { start } = characters.reduceRight(
    (taken, character, index) => {
      if (taken.isFull) return taken;
      const room = taken.room - visibleLength(character);
      return room < 0 ? { ...taken, isFull: true } : { room, start: index, isFull: false };
    },
    { room: width, start: characters.length, isFull: false },
  );
  return characters.slice(start).join("");
};

// A whole frame drawn over the last one in place, each line cleared to its end
// and anything below cleared, so nothing flickers and nothing is pushed into a
// terminal's scrollback (a full clear is, in tmux and iTerm).
export const frame = (lines: readonly string[]): string => `\x1b[H${lines.map((line) => `${line}\x1b[K`).join("\r\n")}\x1b[J`;
