export const IDLE_LIMIT_MS = 15 * 60 * 1000;
export const CALIBRATION_SESSIONS = 10;
const RECENT_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

export type SecondsByDay = Record<string, number>;

export interface Summary {
  secondsMeasured: number;
  secondsLastTwoWeeks: number;
  lastTwoWeeks: number[];
  measuredSince: string;
}

export interface Launches {
  total: number;
  firstStart: number;
}

export interface Bounds {
  lowSeconds: number;
  highSeconds: number;
}

export interface Earlier {
  since: string;
  launches: number;
  bounds: Bounds | null;
}

export interface Calibration {
  sessionSeconds: readonly number[];
  wallSeconds: number;
}

function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function median(values: readonly number[]): number {
  const sorted = Float64Array.from(values).sort();
  const half = Math.floor(sorted.length / 2);
  const middle = sorted.subarray(half - 1 + (sorted.length % 2), half + 1);
  return sum(middle) / middle.length;
}

export function activeSecondsByDay(timestamps: readonly number[]): SecondsByDay {
  const msByDay = new Map<string, number>();
  let previous = Number.NEGATIVE_INFINITY;
  for (const time of Float64Array.from(timestamps).sort()) {
    const start = previous;
    previous = time;
    const gap = time - start;
    if (gap > IDLE_LIMIT_MS) continue;
    const day = dayOf(start);
    msByDay.set(day, (msByDay.get(day) ?? 0) + gap);
  }
  return Object.fromEntries([...msByDay].map(([day, ms]) => [day, Math.round(ms / 1000)]));
}

export function activeSeconds(timestamps: readonly number[]): number {
  return sum(Object.values(activeSecondsByDay(timestamps)));
}

export function rescanFrom(scannedAt: number | undefined, now: number): number {
  if (scannedAt === undefined || scannedAt > now) return 0;
  return Math.floor((scannedAt - IDLE_LIMIT_MS) / DAY_MS) * DAY_MS;
}

export function mergeRecord(record: SecondsByDay, scanned: SecondsByDay): SecondsByDay {
  const merged = { ...record };
  for (const [day, seconds] of Object.entries(scanned)) {
    merged[day] = Math.max(merged[day] ?? 0, seconds);
  }
  return merged;
}

export function summarize(record: SecondsByDay, now: number): Summary | undefined {
  const [measuredSince] = Object.keys(record).sort();
  if (measuredSince === undefined) return undefined;
  const lastTwoWeeks = Array.from(
    { length: RECENT_DAYS },
    (_, i) => record[dayOf(now - (RECENT_DAYS - 1 - i) * DAY_MS)] ?? 0,
  );
  return {
    secondsMeasured: sum(Object.values(record)),
    secondsLastTwoWeeks: sum(lastTwoWeeks),
    lastTwoWeeks,
    measuredSince,
  };
}

export function countEarlier(
  launches: Launches,
  sessions: number,
  measuredSince: string,
): Earlier | null {
  const earlierLaunches = launches.total - sessions;
  if (launches.firstStart >= Date.parse(`${measuredSince}T00:00:00Z`) || earlierLaunches <= 0) {
    return null;
  }
  return { since: dayOf(launches.firstStart), launches: earlierLaunches, bounds: null };
}

export function calibrate(launches: number, calibration: Calibration): Bounds | null {
  const sessions = calibration.sessionSeconds.length;
  if (sessions < CALIBRATION_SESSIONS) return null;
  const typical = median(calibration.sessionSeconds);
  const average = calibration.wallSeconds / sessions;
  return {
    lowSeconds: Math.round(launches * Math.min(typical, average)),
    highSeconds: Math.round(launches * Math.max(typical, average)),
  };
}

export function midpoint(bounds: Bounds): number {
  return Math.round(Math.sqrt(bounds.lowSeconds * bounds.highSeconds));
}
