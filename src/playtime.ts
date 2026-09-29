export const IDLE_LIMIT_MS = 15 * 60 * 1000;
const RECENT_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

export type SecondsByDay = Record<string, number>;

export interface Summary {
  secondsOnRecord: number;
  secondsLastTwoWeeks: number;
  lastTwoWeeks: number[];
  onRecordSince: string;
}

function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
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
  const [onRecordSince] = Object.keys(record).sort();
  if (onRecordSince === undefined) return undefined;
  const lastTwoWeeks = Array.from(
    { length: RECENT_DAYS },
    (_, i) => record[dayOf(now - (RECENT_DAYS - 1 - i) * DAY_MS)] ?? 0,
  );
  return {
    secondsOnRecord: Object.values(record).reduce((sum, s) => sum + s, 0),
    secondsLastTwoWeeks: lastTwoWeeks.reduce((sum, s) => sum + s, 0),
    lastTwoWeeks,
    onRecordSince,
  };
}
