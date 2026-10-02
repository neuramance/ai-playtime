import { describe, expect, it } from "vitest";
import { at } from "./fixtures.ts";
import { addUsage, maxUsage, mergeUsage, modelKey, spendOf } from "./tokens.ts";
import type { UsageByDay } from "./tokens.ts";

const millionEach = {
  input: 1_000_000,
  cacheWrite: 1_000_000,
  cacheWrite1h: 1_000_000,
  cacheRead: 1_000_000,
  output: 1_000_000,
};

describe("modelKey", () => {
  it("strips the last provider prefix and trailing model date", () => {
    expect(modelKey("openai-group/claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(modelKey("provider/openai-group/gpt-6-astra")).toBe("gpt-6-astra");
  });

  it("appends premiums after normalizing the model", () => {
    expect(modelKey("openai-group/claude-opus-5-5-20251001", "fast")).toBe(
      "claude-opus-5-5 (fast)",
    );
    expect(modelKey("openai-group/gpt-6-astra", "long context")).toBe("gpt-6-astra (long context)");
  });
});

describe("spendOf pricing", () => {
  it.each([
    { model: "claude-opus-5-5", usage: millionEach, usd: 37.2, tokens: 5_000_000 },
    { model: "claude-opus-5-5 (fast)", usage: millionEach, usd: 74.4, tokens: 5_000_000 },
    { model: "claude-haiku-4-5 (fast)", usage: millionEach, usd: 9.35, tokens: 5_000_000 },
    {
      model: "claude-fable-5-1",
      usage: { input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 1_000_000, output: 0 },
      usd: 0.25,
      tokens: 1_000_000,
    },
    { model: "gpt-6-astra", usage: millionEach, usd: 73.5, tokens: 5_000_000 },
    { model: "gpt-6-astra (long context)", usage: millionEach, usd: 122, tokens: 5_000_000 },
    { model: "gpt-5.2 (long context)", usage: millionEach, usd: 17.675, tokens: 5_000_000 },
    {
      model: "gpt-5.5",
      usage: { input: 0, cacheWrite: 1_000_000, cacheWrite1h: 0, cacheRead: 0, output: 0 },
      usd: 5,
      tokens: 1_000_000,
    },
  ])("prices $model", ({ model, usage, usd, tokens }) => {
    const spend = spendOf([{ "2025-07-01": { [model]: usage } }]);
    expect(spend.usd).toBeCloseTo(usd, 9);
    expect(spend.tokens).toBe(tokens);
    expect(spend.unpricedTokens).toBe(0);
    expect(spend.unpricedModels).toEqual(new Set());
    expect(spend.since).toBe("2025-07-01");
  });
});

describe("spendOf totals", () => {
  it("counts unknown tokens separately while charging only priced models", () => {
    const spend = spendOf([
      {
        "2025-07-01": {
          "claude-unknown-9": {
            input: 1000,
            cacheWrite: 0,
            cacheWrite1h: 0,
            cacheRead: 0,
            output: 1000,
          },
          "claude-haiku-4-5": {
            input: 1_000_000,
            cacheWrite: 0,
            cacheWrite1h: 0,
            cacheRead: 0,
            output: 1_000_000,
          },
        },
      },
    ]);
    expect(spend.tokens).toBe(2_002_000);
    expect(spend.usd).toBeCloseTo(6, 9);
    expect(spend.unpricedTokens).toBe(2000);
    expect(spend.unpricedModels).toEqual(new Set(["claude-unknown-9"]));
  });

  it("excludes earlier days and finds the first included day across apps", () => {
    const spend = spendOf(
      [
        {
          "2025-07-03": {
            "claude-haiku-4-5": {
              input: 0,
              cacheWrite: 0,
              cacheWrite1h: 0,
              cacheRead: 0,
              output: 1_000_000,
            },
          },
          "2025-07-01": {
            "claude-unknown-9": millionEach,
            "claude-haiku-4-5": {
              input: 1_000_000,
              cacheWrite: 0,
              cacheWrite1h: 0,
              cacheRead: 0,
              output: 0,
            },
          },
        },
        {
          "2025-07-02": {
            "claude-haiku-4-5": {
              input: 1_000_000,
              cacheWrite: 0,
              cacheWrite1h: 0,
              cacheRead: 0,
              output: 0,
            },
          },
        },
      ],
      "2025-07-02",
    );
    expect(spend.tokens).toBe(2_000_000);
    expect(spend.usd).toBeCloseTo(6, 9);
    expect(spend.since).toBe("2025-07-02");
    expect(spend.unpricedTokens).toBe(0);
    expect(spend.unpricedModels).toEqual(new Set());
  });
});

describe("maxUsage", () => {
  it("takes each kind's maximum independently", () => {
    expect(
      maxUsage(
        { input: 10, cacheWrite: 20, cacheWrite1h: 30, cacheRead: 40, output: 50 },
        { input: 12, cacheWrite: 15, cacheWrite1h: 35, cacheRead: 25, output: 60 },
      ),
    ).toEqual({ input: 12, cacheWrite: 20, cacheWrite1h: 35, cacheRead: 40, output: 60 });
  });
});

describe("addUsage", () => {
  it("sums each kind within a model and UTC day while separating midnight", () => {
    const days: UsageByDay = {};
    addUsage(days, at("2025-07-01T23:59:58Z"), "claude-opus-5-5", {
      input: 10,
      cacheWrite: 20,
      cacheWrite1h: 30,
      cacheRead: 40,
      output: 50,
    });
    addUsage(days, at("2025-07-01T23:59:59Z"), "claude-opus-5-5", {
      input: 1,
      cacheWrite: 2,
      cacheWrite1h: 3,
      cacheRead: 4,
      output: 5,
    });
    addUsage(days, at("2025-07-02T00:00:00Z"), "claude-opus-5-5", {
      input: 6,
      cacheWrite: 7,
      cacheWrite1h: 8,
      cacheRead: 9,
      output: 10,
    });
    expect(days).toEqual({
      "2025-07-01": {
        "claude-opus-5-5": {
          input: 11,
          cacheWrite: 22,
          cacheWrite1h: 33,
          cacheRead: 44,
          output: 55,
        },
      },
      "2025-07-02": {
        "claude-opus-5-5": { input: 6, cacheWrite: 7, cacheWrite1h: 8, cacheRead: 9, output: 10 },
      },
    });
  });

  it("does not create a day or model for all-zero usage", () => {
    const days: UsageByDay = {};
    addUsage(days, at("2025-07-01T10:00:00Z"), "<synthetic>", {
      input: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
      output: 0,
    });
    expect(days).toEqual({});
  });
});

describe("mergeUsage", () => {
  it("takes per-kind maxima, retains saved days and models, and adds scanned ones", () => {
    const record = {
      "2025-06-30": {
        old: { input: 1, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 2 },
      },
      "2025-07-01": {
        shared: { input: 10, cacheWrite: 20, cacheWrite1h: 30, cacheRead: 40, output: 50 },
        saved: { input: 3, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 4 },
      },
    };
    const scanned = {
      "2025-07-01": {
        shared: { input: 12, cacheWrite: 15, cacheWrite1h: 35, cacheRead: 25, output: 60 },
        added: { input: 5, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 6 },
      },
      "2025-07-02": {
        new: { input: 7, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 8 },
      },
    };
    expect(mergeUsage(record, scanned)).toEqual({
      "2025-06-30": {
        old: { input: 1, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 2 },
      },
      "2025-07-01": {
        shared: { input: 12, cacheWrite: 20, cacheWrite1h: 35, cacheRead: 40, output: 60 },
        saved: { input: 3, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 4 },
        added: { input: 5, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 6 },
      },
      "2025-07-02": {
        new: { input: 7, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 8 },
      },
    });
    expect(record).toEqual({
      "2025-06-30": {
        old: { input: 1, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 2 },
      },
      "2025-07-01": {
        shared: { input: 10, cacheWrite: 20, cacheWrite1h: 30, cacheRead: 40, output: 50 },
        saved: { input: 3, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 4 },
      },
    });
    expect(scanned).toEqual({
      "2025-07-01": {
        shared: { input: 12, cacheWrite: 15, cacheWrite1h: 35, cacheRead: 25, output: 60 },
        added: { input: 5, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 6 },
      },
      "2025-07-02": {
        new: { input: 7, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 8 },
      },
    });
  });
});
