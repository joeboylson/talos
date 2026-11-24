// A loop's schedule, in cron's five fields (minute hour day month weekday), in
// the machine's own time. Each field is `*`, a number, a range `a-b`, any of
// those with a step `/n`, or a comma list of them.

export type Cron = {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  weekdays: ReadonlySet<number>;
  // Cron's rule: when both day and weekday are set, matching either one is enough.
  isDayOrWeekday: boolean;
};

const MINUTE_MS = 60_000;
const FIELD_RANGES = [
  { low: 0, high: 59 },
  { low: 0, high: 23 },
  { low: 1, high: 31 },
  { low: 1, high: 12 },
  // 7 is Sunday too, as in most crons.
  { low: 0, high: 7 },
] as const;

const parseWholeNumber = (text: string): number | null => (/^\d+$/.test(text) ? Number(text) : null);

const parseItem = (item: string, low: number, high: number): number[] | null => {
  const [span, stepText, ...extra] = item.split("/");
  if (span === undefined || extra.length > 0) return null;
  const step = stepText === undefined ? 1 : parseWholeNumber(stepText);
  if (!step) return null;
  const [startText, endText, ...extraEnds] = span.split("-");
  if (startText === undefined || extraEnds.length > 0) return null;
  const isEvery = span === "*";
  const start = isEvery ? low : parseWholeNumber(startText);
  const end = isEvery ? high : endText === undefined ? (stepText === undefined ? start : high) : parseWholeNumber(endText);
  if (start === null || end === null || start < low || end > high || start > end) return null;
  return Array.from({ length: Math.floor((end - start) / step) + 1 }, (_, index) => start + index * step);
};

const parseField = (field: string, low: number, high: number): Set<number> | null => {
  const items = field.split(",").map((item) => parseItem(item, low, high));
  return items.every((values) => values !== null) ? new Set(items.flat()) : null;
};

export const parseCron = (text: string): Cron | null => {
  const fields = text.trim().split(/\s+/);
  if (fields.length !== FIELD_RANGES.length) return null;
  const sets = fields.map((field, index) => parseField(field, FIELD_RANGES[index]!.low, FIELD_RANGES[index]!.high));
  const [minutes, hours, days, months, weekdaysWithSeven] = sets;
  if (!minutes || !hours || !days || !months || !weekdaysWithSeven) return null;
  const weekdays = new Set([...weekdaysWithSeven].map((weekday) => weekday % 7));
  return { minutes, hours, days, months, weekdays, isDayOrWeekday: fields[2] !== "*" && fields[4] !== "*" };
};

const matchesCron = (cron: Cron, date: Date): boolean => {
  const isDay = cron.days.has(date.getDate());
  const isWeekday = cron.weekdays.has(date.getDay());
  const isDayMatched = cron.isDayOrWeekday ? isDay || isWeekday : isDay && isWeekday;
  return cron.minutes.has(date.getMinutes()) && cron.hours.has(date.getHours()) && cron.months.has(date.getMonth() + 1) && isDayMatched;
};

// Clocks go back by one of these amounts, and then a local time happens twice.
const CLOCK_BACK_SHIFTS_MS = [30, 60, 120].map((minutes) => minutes * MINUTE_MS);
const wallTime = (date: Date): string => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()} ${date.getHours()}:${date.getMinutes()}`;
const isWallTimeRepeated = (minuteMs: number): boolean =>
  CLOCK_BACK_SHIFTS_MS.some((shiftMs) => wallTime(new Date(minuteMs - shiftMs)) === wallTime(new Date(minuteMs)));

// Walks minute by minute from afterMs (not included) to untilMs (included). A
// loop lasts 7 days at most, so that's about 10,000 minutes. A local time that
// happens twice when the clocks go back counts once, as in most crons.
export const dueTimesBetween = (cron: Cron, afterMs: number, untilMs: number): number[] => {
  const firstMinuteMs = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const minuteCount = Math.max(0, Math.floor((untilMs - firstMinuteMs) / MINUTE_MS) + 1);
  const minutes = Array.from({ length: minuteCount }, (_, index) => firstMinuteMs + index * MINUTE_MS);
  return minutes.filter((minuteMs) => matchesCron(cron, new Date(minuteMs)) && !isWallTimeRepeated(minuteMs));
};
