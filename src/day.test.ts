import { describe, expect, it } from 'vitest';
import { clockBehind, nextRollover, reviewTime, shiftMin, studyDay } from './day.ts';
import { wall, zone } from './testing/zones.ts';

const H = 3_600_000;
const R = 4; // the default rollover hour

describe.each(['America/New_York', 'Europe/Berlin', 'Asia/Kolkata'])('study days in %s', (tz) => {
  const z = zone(tz);
  const at = (text: string) => wall(z, text);

  it('rolls over at 04:00, not midnight', () => {
    expect(studyDay(at('2026-06-10T00:30'), R, z)).toBe('2026-06-09');
    expect(studyDay(at('2026-06-10T03:59'), R, z)).toBe('2026-06-09');
    expect(studyDay(at('2026-06-10T04:00'), R, z)).toBe('2026-06-10');
    expect(studyDay(at('2026-06-10T23:59'), R, z)).toBe('2026-06-10');
  });

  it('counts a 21:00 session and the next 08:00 as two days', () => {
    expect(studyDay(at('2026-06-10T21:00'), R, z)).toBe('2026-06-10');
    expect(studyDay(at('2026-06-11T08:00'), R, z)).toBe('2026-06-11');
  });

  it('finds the next rollover', () => {
    expect(nextRollover(at('2026-06-10T08:00'), R, z)).toBe(at('2026-06-11T04:00'));
    expect(nextRollover(at('2026-06-10T03:00'), R, z)).toBe(at('2026-06-10T04:00'));
    expect(nextRollover(at('2026-06-10T04:00'), R, z)).toBe(at('2026-06-11T04:00'));
  });

  it('follows a different rollover hour', () => {
    expect(studyDay(at('2026-06-10T01:59'), 2, z)).toBe('2026-06-09');
    expect(studyDay(at('2026-06-10T02:00'), 2, z)).toBe('2026-06-10');
    expect(studyDay(at('2026-06-10T00:00'), 0, z)).toBe('2026-06-10');
  });
});

describe.each([
  { tz: 'America/New_York', spring: '2026-03-08', fall: '2026-11-01' },
  { tz: 'Europe/Berlin', spring: '2026-03-29', fall: '2026-10-25' },
])('a DST change in $tz', ({ tz, spring, fall }) => {
  const z = zone(tz);
  const at = (text: string) => wall(z, text);
  const dayBefore = (d: string) => new Date(Date.parse(d) - 24 * H).toISOString().slice(0, 10);

  it('changes the shift', () => {
    expect(shiftMin(at(`${spring}T12:00`), R, z) - shiftMin(at(`${dayBefore(spring)}T12:00`), R, z)).toBe(60);
    expect(shiftMin(at(`${fall}T12:00`), R, z) - shiftMin(at(`${dayBefore(fall)}T12:00`), R, z)).toBe(-60);
  });

  it('still rolls over at 04:00 local on the day of the change', () => {
    for (const d of [spring, fall]) {
      expect(studyDay(at(`${d}T03:59`), R, z)).toBe(dayBefore(d));
      expect(studyDay(at(`${d}T04:00`), R, z)).toBe(d);
      expect(nextRollover(at(`${d}T01:00`), R, z)).toBe(at(`${d}T04:00`));
    }
  });

  it('makes the study day before a spring change 23 hours long, and before a fall change 25', () => {
    const springStart = at(`${dayBefore(spring)}T04:00`);
    const fallStart = at(`${dayBefore(fall)}T04:00`);
    expect(nextRollover(springStart, R, z) - springStart).toBe(23 * H);
    expect(nextRollover(fallStart, R, z) - fallStart).toBe(25 * H);
  });

  it('finds the rollover when its hour is the one a spring change skips', () => {
    // Berlin skips 02:00-03:00 and New York 02:00-03:00: with a 02:00
    // rollover, the new day starts when the clock jumps to 03:00.
    const ts = nextRollover(at(`${spring}T01:00`), 2, z);
    expect(ts).toBe(at(`${spring}T03:00`));
    expect(studyDay(ts, 2, z)).toBe(spring);
    expect(studyDay(ts - 1, 2, z)).toBe(dayBefore(spring));
  });
});

describe('the clock clamp', () => {
  const last = Date.parse('2026-06-10T12:00:00Z');

  it('uses the clock when it is ahead of the last review', () => {
    expect(reviewTime(last + 60_000, last)).toBe(last + 60_000);
  });

  it('uses one second after the last review when the clock is behind or level', () => {
    expect(reviewTime(last - H, last)).toBe(last + 1000);
    expect(reviewTime(last, last)).toBe(last + 1000);
  });

  it('uses the clock for a card never reviewed', () => {
    expect(reviewTime(last, null)).toBe(last);
    expect(reviewTime(last, undefined)).toBe(last);
  });

  it('warns only when the clock is more than 5 minutes behind the log', () => {
    expect(clockBehind(last - 5 * 60_000, last)).toBe(false);
    expect(clockBehind(last - 5 * 60_000 - 1, last)).toBe(true);
    expect(clockBehind(last + H, last)).toBe(false);
    expect(clockBehind(last, null)).toBe(false);
  });
});
