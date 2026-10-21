// The next interval each rating button would give (SPEC.md, Screens:
// Review). It runs the same scheduler call the answer will, at the same
// clamped time, so the labels match what rating does, apart from fuzz when
// the rating comes in a later minute than the preview.

import { reviewTime } from '../day.ts';
import { review, type CardState, type Params, type Rating } from '../scheduler.ts';

export const RATINGS: readonly Rating[] = [1, 2, 3, 4];

/** For each rating, milliseconds from the review to the card's next due time. */
export function previewIntervals(params: Params, before: CardState | null, now: number, shiftMin: number): Record<Rating, number> {
  const ts = reviewTime(now, before?.lastReview);
  const out = {} as Record<Rating, number>;
  for (const r of RATINGS) out[r] = review(params, before, r, ts, shiftMin).due - ts;
  return out;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A short label: "10 min", "5 h", "3 d", "4 mo", "1.5 y". */
export function formatInterval(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MIN))} min`;
  if (ms < DAY) return `${Math.round(ms / HOUR)} h`;
  const days = ms / DAY;
  if (days < 31) return `${Math.round(days)} d`;
  if (days < 365) return `${Math.round(days / 30.4)} mo`;
  const years = Math.round((days / 365) * 10) / 10;
  return `${years} y`;
}
