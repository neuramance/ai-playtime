import { readFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  DAY,
  MINUTE,
  at,
  claudeTokenDays,
  claudeTokenHome,
  dayKey,
  emptyDir,
  events,
  iso,
  json,
  onOneUtcDay,
  recordPath,
  rollout,
  run,
  saveRecord,
  utcToday,
  write,
} from "./fixtures.ts";

it("backfills old Codex tokens when upgrading a record without tokens", () => {
  onOneUtcDay(() => {
    const home = emptyDir();
    const yesterday = utcToday() - DAY;
    saveRecord(home, yesterday + 12 * 60 * MINUTE, { [dayKey(yesterday)]: 600 });
    const start = at("2025-07-01T10:00:00Z");
    const lines = [
      { type: "turn_context", payload: { model: "gpt-5.5" } },
      {
        type: "token_usage_record",
        payload: {
          response_id: "old",
          usage: {
            input_tokens: 1000,
            cached_input_tokens: 0,
            output_tokens: 1000,
            total_tokens: 2000,
          },
        },
      },
    ];
    const path = write(
      home,
      ".codex/sessions/rollout-a.jsonl",
      rollout("codex-tui", [start]) +
        lines
          .map((line, i) => JSON.stringify({ timestamp: iso(start + (i + 1) * MINUTE), ...line }))
          .join("\n"),
    );
    utimesSync(path, new Date(start), new Date(start));
    const usageByDay = {
      "2025-07-01": {
        "gpt-5.5": { input: 1000, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 1000 },
      },
    };
    expect(json(home)).toMatchObject({
      tokensOnRecord: 2000,
      usdOnRecord: 0.04,
      apps: [
        { app: "Claude Code", tokens: 0 },
        { app: "Codex", tokens: 2000, usd: 0.04, usageByDay },
      ],
    });
    expect(JSON.parse(readFileSync(recordPath(home), "utf8"))).toMatchObject({
      tokens: { codex: usageByDay },
    });
  });
});

it("keeps Claude tokens and spend after the transcripts are deleted", () => {
  const home = claudeTokenHome();
  const expected = {
    tokensOnRecord: 1305000,
    usdOnRecord: 2.36,
    apps: [{ app: "Claude Code", tokens: 1305000, usd: 2.36, usageByDay: claudeTokenDays }],
  };
  expect(json(home)).toMatchObject(expected);
  rmSync(join(home, ".claude/projects"), { recursive: true });
  expect(json(home)).toMatchObject(expected);
});

it.each([-1, 0.5])(
  "rejects a record containing an invalid token count of %s without overwriting it",
  (input) => {
    const home = emptyDir();
    const record = JSON.stringify({
      version: 1,
      scannedAt: "2025-07-01T12:00:00.000Z",
      apps: { "claude-code": { "2025-07-01": 600 } },
      earlier: null,
      tokens: {
        "claude-code": {
          "2025-07-01": {
            "claude-haiku-4-5": {
              input,
              cacheWrite: 0,
              cacheWrite1h: 0,
              cacheRead: 0,
              output: 1000,
            },
          },
        },
      },
    });
    write(home, ".local/share/ai-playtime/record.json", record);
    expect({ ...run(home), record: readFileSync(recordPath(home), "utf8") }).toEqual({
      status: 1,
      stdout: "",
      stderr: `ai-playtime: ${recordPath(home)} is not a valid AI Playtime record; restore ${recordPath(home)}.bak or remove it\n`,
      record,
    });
  },
);

it("counts a reply streamed across UTC midnight once when a later run rescans only the new day", () => {
  const home = emptyDir();
  const reply = (timestamp: string, output: number) =>
    JSON.stringify({
      timestamp,
      entrypoint: "cli",
      message: {
        id: "msg_midnight",
        model: "claude-haiku-4-5",
        usage: { input_tokens: 10000, output_tokens: output },
      },
    });
  write(
    home,
    ".claude/projects/-work/s1.jsonl",
    `${events([at("2025-07-01T23:55:00Z")])}${reply("2025-07-01T23:59:56Z", 10)}\n${reply("2025-07-02T00:00:21Z", 20000)}\n`,
  );
  const usageByDay = {
    "2025-07-01": {
      "claude-haiku-4-5": {
        input: 10000,
        cacheWrite: 0,
        cacheWrite1h: 0,
        cacheRead: 0,
        output: 20000,
      },
    },
  };
  expect(json(home)).toMatchObject({ apps: [{ app: "Claude Code", usageByDay }] });
  const record = JSON.parse(readFileSync(recordPath(home), "utf8")) as Record<string, unknown>;
  write(
    home,
    ".local/share/ai-playtime/record.json",
    JSON.stringify({ ...record, scannedAt: "2025-07-02T00:30:00.000Z" }),
  );
  expect(json(home)).toMatchObject({ tokensOnRecord: 30000, apps: [{ usageByDay }] });
});

it("ignores log usage with impossible token counts and keeps the record loadable", () => {
  const home = emptyDir();
  const start = at("2025-07-01T10:00:00Z");
  const usage = (input: number, cached: number) => ({
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: 1000,
    total_tokens: input + 1000,
  });
  const lines = [
    { type: "turn_context", payload: { model: "gpt-5.5" } },
    { type: "token_usage_record", payload: { response_id: "bad", usage: usage(10, 20) } },
    { type: "token_usage_record", payload: { response_id: "good", usage: usage(1000, 0) } },
  ];
  write(
    home,
    ".codex/sessions/rollout-a.jsonl",
    rollout("codex-tui", [start]) +
      lines
        .map((line, i) => JSON.stringify({ timestamp: iso(start + (i + 1) * MINUTE), ...line }))
        .join("\n"),
  );
  const claudeUsage = {
    input_tokens: 10,
    cache_creation_input_tokens: 10,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 20 },
    output_tokens: 10,
  };
  write(
    home,
    ".claude/projects/-work/s1.jsonl",
    events([start]) +
      JSON.stringify({
        timestamp: iso(start + 10 * MINUTE),
        message: { id: "bad", model: "claude-haiku-4-5", usage: claudeUsage },
      }),
  );
  const first = run(home, "--json");
  const second = run(home, "--json");
  expect({ statuses: [first.status, second.status], stderr: second.stderr }).toEqual({
    statuses: [0, 0],
    stderr: "",
  });
  expect(JSON.parse(second.stdout)).toMatchObject({ tokensOnRecord: 2000 });
});
