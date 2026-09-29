import { describe, expect, it } from "vitest";
import { activeSecondsByDay, mergeRecord, rescanFrom, summarize } from "./playtime.ts";

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
      secondsOnRecord: 650,
      secondsLastTwoWeeks: 500,
      lastTwoWeeks: [200, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 300],
      onRecordSince: "2026-01-01",
    });
  });
});
