import { describe, expect, it } from "vitest";
import {
  activeSeconds,
  activeSecondsByDay,
  calibrate,
  countEarlier,
  mergeRecord,
  midpoint,
  rescanFrom,
  summarize,
} from "./playtime.ts";

const MINUTE = 60_000;
const at = (iso: string) => Date.parse(iso);

describe("activeSecondsByDay", () => {
  it("counts gaps up to 15 minutes as active and longer gaps as idle", () => {
    const start = at("2026-09-01T10:00:00Z");
    const timestamps = [start, start + 15 * MINUTE, start + 30 * MINUTE + 1];
    expect(activeSecondsByDay(timestamps)).toEqual({ "2026-09-01": 900 });
  });

  it("counts overlapping sessions once", () => {
    const start = at("2026-09-01T10:00:00Z");
    const sessionA = [start, start + 5 * MINUTE];
    const sessionB = [start + 2 * MINUTE, start + 7 * MINUTE];
    expect(activeSecondsByDay([...sessionA, ...sessionB])).toEqual({ "2026-09-01": 420 });
  });

  it("credits a gap that crosses midnight UTC to the day it started", () => {
    const timestamps = [at("2026-09-01T23:55:00Z"), at("2026-09-02T00:05:00Z")];
    expect(activeSecondsByDay(timestamps)).toEqual({ "2026-09-01": 600 });
  });
});

describe("activeSeconds", () => {
  it("totals active time across days", () => {
    const timestamps = [
      at("2026-09-01T23:50:00Z"),
      at("2026-09-01T23:55:00Z"),
      at("2026-09-02T00:05:00Z"),
    ];
    expect(activeSeconds(timestamps)).toBe(900);
  });
});

describe("mergeRecord", () => {
  it("keeps days whose transcripts are gone and adds new days", () => {
    expect(mergeRecord({ "2026-08-01": 100 }, { "2026-09-02": 10 })).toEqual({
      "2026-08-01": 100,
      "2026-09-02": 10,
    });
  });

  it("takes the larger total for a day seen before", () => {
    expect(
      mergeRecord({ "2026-09-01": 50, "2026-09-02": 80 }, { "2026-09-01": 70, "2026-09-02": 30 }),
    ).toEqual({
      "2026-09-01": 70,
      "2026-09-02": 80,
    });
  });
});

describe("rescanFrom", () => {
  it("scans everything when there is no previous scan", () => {
    expect(rescanFrom(undefined, at("2026-09-12T00:00:00Z"))).toBe(0);
  });

  it("rescans from the start of the UTC day of the previous scan", () => {
    expect(rescanFrom(at("2026-09-10T15:30:00Z"), at("2026-09-12T08:00:00Z"))).toBe(
      at("2026-09-10T00:00:00Z"),
    );
  });

  it("reaches back a day when the previous scan was within 15 minutes of midnight", () => {
    expect(rescanFrom(at("2026-09-10T00:05:00Z"), at("2026-09-12T08:00:00Z"))).toBe(
      at("2026-09-09T00:00:00Z"),
    );
  });

  it("scans everything when the previous scan is in the future", () => {
    expect(rescanFrom(at("2026-09-13T00:00:00Z"), at("2026-09-12T08:00:00Z"))).toBe(0);
  });
});

describe("summarize", () => {
  it("has nothing to summarize without a record", () => {
    expect(summarize({}, at("2026-09-29T12:00:00Z"))).toBeUndefined();
  });

  it("totals every day and the 14 UTC days ending today", () => {
    const record = {
      "2026-09-29": 300,
      "2026-09-15": 100,
      "2026-09-16": 200,
      "2026-01-01": 50,
    };
    expect(summarize(record, at("2026-09-29T12:00:00Z"))).toEqual({
      secondsMeasured: 650,
      secondsLastTwoWeeks: 500,
      lastTwoWeeks: [200, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 300],
      measuredSince: "2026-01-01",
    });
  });
});

describe("countEarlier", () => {
  const launches = { total: 110, firstStart: at("2025-06-23T09:00:00Z") };

  it("counts launches not matched by a measured session, pending calibration", () => {
    expect(countEarlier(launches, 10, "2026-09-01")).toEqual({
      since: "2025-06-23",
      launches: 100,
      bounds: null,
    });
  });

  it("counts nothing when Claude Code was first started on the first measured day", () => {
    const firstStart = at("2026-09-01T00:00:00Z");
    expect(countEarlier({ ...launches, firstStart }, 10, "2026-09-01")).toBeNull();
  });

  it("counts nothing when the measured sessions account for every launch", () => {
    expect(countEarlier(launches, 110, "2026-09-01")).toBeNull();
  });
});

describe("calibrate", () => {
  const tenSessions = [10_800, 3600, 1800, 1800, 1800, 1800, 1800, 1800, 1800, 1800];

  it("bounds each earlier launch by the typical and the average measured session", () => {
    expect(calibrate(100, { sessionSeconds: tenSessions, wallSeconds: 28_800 })).toEqual({
      lowSeconds: 180_000,
      highSeconds: 288_000,
    });
  });

  it("takes the middle session as typical when the count is odd", () => {
    const eleven = [100, 100, 100, 100, 100, 200, 900, 900, 900, 900, 900];
    expect(calibrate(10, { sessionSeconds: eleven, wallSeconds: 5500 })).toEqual({
      lowSeconds: 2000,
      highSeconds: 5000,
    });
  });

  it("waits for 10 measured sessions", () => {
    expect(
      calibrate(100, { sessionSeconds: tenSessions.slice(1), wallSeconds: 18_000 }),
    ).toBeNull();
  });
});

describe("midpoint", () => {
  it("is the geometric mean of the bounds", () => {
    expect(midpoint({ lowSeconds: 180_000, highSeconds: 288_000 })).toBe(227_684);
  });
});
