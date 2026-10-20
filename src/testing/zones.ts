// Named time zones for tests, so day-boundary tests don't depend on the
// machine's own zone.

import type { Zone } from '../day.ts';

const MIN_MS = 60_000;

/** A Zone for an IANA time zone name, read through Intl. */
export function zone(tz: string): Zone {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  return (ts) => {
    const parts = fmt.formatToParts(ts);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const wallAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return Math.round((wallAsUtc - Math.floor(ts / 1000) * 1000) / MIN_MS);
  };
}

/** The instant a wall clock in that zone reads `YYYY-MM-DDTHH:MM`. */
export function wall(z: Zone, text: string): number {
  const asUtc = Date.parse(text + 'Z');
  const guess = asUtc - z(asUtc) * MIN_MS;
  return asUtc - z(guess) * MIN_MS;
}
