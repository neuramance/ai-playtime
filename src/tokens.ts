import { dayOf } from "./playtime.ts";

const KINDS = ["input", "cacheWrite", "cacheWrite1h", "cacheRead", "output"] as const;

export type Usage = Record<(typeof KINDS)[number], number>;

export type UsageByDay = Record<string, Record<string, Usage>>;

export interface Spend {
  tokens: number;
  usd: number;
  unpricedTokens: number;
  unpricedModels: Set<string>;
  since: string | undefined;
}

type Premium = "fast" | "long context";

const DATE_SUFFIX = /-\d{8}$/;

const PREMIUMS: Record<Premium, { multipliers: Usage; models: ReadonlySet<string> }> = {
  fast: {
    multipliers: { input: 2, cacheWrite: 2, cacheWrite1h: 2, cacheRead: 2, output: 2 },
    models: new Set(["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"]),
  },
  "long context": {
    multipliers: { input: 2, cacheWrite: 2, cacheWrite1h: 2, cacheRead: 2, output: 1.5 },
    models: new Set([
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-daybreak-blue-latest",
      "gpt-5.5",
      "gpt-5.4",
    ]),
  },
};

function claude(input: number, cacheRead: number, output: number): Usage {
  return { input, cacheWrite: input * 1.25, cacheWrite1h: input * 2, cacheRead, output };
}

function openai(input: number, cacheRead: number, output: number, cacheWrite = input): Usage {
  return { input, cacheWrite, cacheWrite1h: 0, cacheRead, output };
}

const PRICES: Partial<Record<string, Usage>> = {
  "claude-fable-5-1": claude(10, 0.25, 50),
  "claude-mythos-5-1": claude(10, 0.25, 50),
  "claude-fable-5": claude(10, 1, 50),
  "claude-mythos-5": claude(10, 1, 50),
  "claude-opus-5-5": claude(4, 0.2, 20),
  "claude-opus-5": claude(5, 0.5, 25),
  "claude-opus-4-8": claude(5, 0.5, 25),
  "claude-opus-4-7": claude(5, 0.5, 25),
  "claude-opus-4-6": claude(5, 0.5, 25),
  "claude-opus-4-5": claude(5, 0.5, 25),
  "claude-sonnet-5-5": claude(2, 0.2, 10),
  "claude-sonnet-5": claude(2, 0.2, 10),
  "claude-sonnet-4-6": claude(3, 0.3, 15),
  "claude-sonnet-4-5": claude(3, 0.3, 15),
  "claude-haiku-4-5": claude(1, 0.1, 5),
  "gpt-6.1-sol": openai(2, 0.1, 10, 2.5),
  "gpt-6-astra": openai(10, 1, 50, 12.5),
  "gpt-6-sol": openai(2, 0.2, 10, 2.5),
  "gpt-6-luna": openai(0.1, 0.01, 0.5, 0.125),
  "gpt-5.6-sol": openai(4, 0.4, 20, 5),
  "gpt-5.6-terra": openai(2, 0.2, 12, 2.5),
  "gpt-5.6-luna": openai(0.2, 0.02, 1.2, 0.25),
  "gpt-daybreak-blue-latest": openai(4, 0.4, 20, 5),
  "gpt-daybreak-red-latest": openai(12.5, 1.25, 75, 15.625),
  "gpt-5.5": openai(5, 0.5, 30),
  "gpt-5.4": openai(2.5, 0.25, 15),
  "gpt-5.4-mini": openai(0.75, 0.075, 4.5),
  "gpt-5.3-codex": openai(1.75, 0.175, 14),
  "gpt-5.2": openai(1.75, 0.175, 14),
  "gpt-5.2-codex": openai(1.75, 0.175, 14),
  "gpt-5.1": openai(1.25, 0.125, 10),
  "gpt-5.1-codex": openai(1.25, 0.125, 10),
  "gpt-5.1-codex-max": openai(1.25, 0.125, 10),
  "gpt-5.1-codex-mini": openai(0.25, 0.025, 2),
  "gpt-5": openai(1.25, 0.125, 10),
  "gpt-5-codex": openai(1.25, 0.125, 10),
  "gpt-5-mini": openai(0.25, 0.025, 2),
  "gpt-5-nano": openai(0.05, 0.005, 0.4),
  "codex-mini-latest": openai(1.5, 0.375, 6),
  o3: openai(2, 0.5, 8),
  "o4-mini": openai(1.1, 0.275, 4.4),
  "gpt-4.1": openai(2, 0.5, 8),
};

function total(usage: Usage): number {
  return usage.input + usage.cacheWrite + usage.cacheWrite1h + usage.cacheRead + usage.output;
}

export function modelKey(model: string, premium?: Premium): string {
  const id = model.slice(model.lastIndexOf("/") + 1).replace(DATE_SUFFIX, "");
  return premium === undefined ? id : `${id} (${premium})`;
}

function combine(a: Usage, b: Usage, op: (x: number, y: number) => number): Usage {
  const combined = { ...a };
  for (const kind of KINDS) combined[kind] = op(a[kind], b[kind]);
  return combined;
}

export function maxUsage(a: Usage, b: Usage): Usage {
  return combine(a, b, Math.max);
}

export function addUsage(days: UsageByDay, time: number, model: string, usage: Usage): void {
  if (total(usage) === 0) return;
  const models = (days[dayOf(time)] ??= {});
  const sum = models[model];
  models[model] = sum === undefined ? usage : combine(sum, usage, (x, y) => x + y);
}

export function mergeUsage(record: UsageByDay, scanned: UsageByDay): UsageByDay {
  const merged = structuredClone(record);
  for (const [day, models] of Object.entries(scanned)) {
    const savedModels = (merged[day] ??= {});
    for (const [model, usage] of Object.entries(models)) {
      const saved = savedModels[model];
      savedModels[model] = saved === undefined ? usage : maxUsage(saved, usage);
    }
  }
  return merged;
}

function priceOf(key: string): Usage | undefined {
  for (const [premium, { multipliers, models }] of Object.entries(PREMIUMS)) {
    const suffix = ` (${premium})`;
    if (!key.endsWith(suffix)) continue;
    const model = key.slice(0, -suffix.length);
    const prices = PRICES[model];
    if (prices === undefined || !models.has(model)) return prices;
    return combine(prices, multipliers, (price, multiplier) => price * multiplier);
  }
  return PRICES[key];
}

function costOf(model: string, usage: Usage): number | undefined {
  const prices = priceOf(model);
  if (prices === undefined) return undefined;
  return KINDS.reduce((sum, kind) => sum + usage[kind] * prices[kind], 0) / 1_000_000;
}

export function spendOf(usages: readonly UsageByDay[], from = ""): Spend {
  const spend: Spend = {
    tokens: 0,
    usd: 0,
    unpricedTokens: 0,
    unpricedModels: new Set(),
    since: undefined,
  };
  for (const [day, models] of usages.flatMap((days) => Object.entries(days))) {
    if (day < from) continue;
    if (spend.since === undefined || day < spend.since) spend.since = day;
    for (const [model, usage] of Object.entries(models)) {
      const tokens = total(usage);
      const usd = costOf(model, usage);
      spend.tokens += tokens;
      if (usd === undefined) {
        spend.unpricedTokens += tokens;
        spend.unpricedModels.add(model);
        continue;
      }
      spend.usd += usd;
    }
  }
  return spend;
}
