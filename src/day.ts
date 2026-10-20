// Study days and the clock (SPEC.md, Days and the clock).
//
// A study day rolls over at a local hour (04:00 by default), not at midnight,
// so a late-night session counts toward the day it started in. Everything is
// done by shifting real time by `shiftMin` minutes, so that the UTC calendar
// date of the shifted instant is the study day. ts-fsrs counts elapsed days by
// UTC calendar date, so the scheduler applies the same shift (scheduler.ts).

export const DEFAULT_ROLLOVER_HOUR = 4;
/** Home warns when the clock reads this much earlier than the newest log row. */
export const CLOCK_WARN_MS = 5 * 60_000;

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * The local UTC offset in minutes at an instant, east positive (New York in
 * summer is -240). The opposite sign of Date's getTimezoneOffset.
 */
export type Zone = (ts: number) => number;

export const localZone: Zone = (ts) => -new Date(ts).getTimezoneOffset();

/** The shift for an instant: the local UTC offset minus the rollover hour. */
export function shiftMin(ts: number, rolloverHour: number, zone: Zone = localZone): number {
  return zone(ts) - rolloverHour * 60;
}

/** The study day an instant counts toward, as YYYY-MM-DD. */
export function studyDay(ts: number, rolloverHour: number, zone: Zone = localZone): string {
  return new Date(ts + shiftMin(ts, rolloverHour, zone) * MIN_MS).toISOString().slice(0, 10);
}

/** The first instant after `ts` that belongs to the next study day. */
export function nextRollover(ts: number, rolloverHour: number, zone: Zone = localZone): number {
  const today = studyDay(ts, rolloverHour, zone);
  const shifted = ts + shiftMin(ts, rolloverHour, zone) * MIN_MS;
  const nextStart = (Math.floor(shifted / DAY_MS) + 1) * DAY_MS;
  // The rollover's real instant depends on the offset at the rollover, which
  // differs from the offset now when a DST change falls in between. Solve with
  // today's offset, then with the offset at that answer. When the rollover hour
  // falls in the hour a spring change skips, only the first answer is in the
  // new day, so take the earliest one that is.
  const first = nextStart - shiftMin(ts, rolloverHour, zone) * MIN_MS;
  const second = nextStart - shiftMin(first, rolloverHour, zone) * MIN_MS;
  const valid = [first, second].filter((c) => c > ts && studyDay(c, rolloverHour, zone) !== today);
  return valid.length ? Math.min(...valid) : first;
}

/**
 * The review time used: the clock, but never earlier than one second after
 * the card's last review, so a clock set backwards can't produce a negative
 * interval or reorder a card's history.
 */
export function reviewTime(now: number, lastReview: number | null | undefined): number {
  return lastReview == null ? now : Math.max(now, lastReview + 1000);
}

/** True when the clock reads more than 5 minutes earlier than the newest log row. */
export function clockBehind(now: number, newestLogTs: number | null | undefined): boolean {
  return newestLogTs != null && now < newestLogTs - CLOCK_WARN_MS;
}
