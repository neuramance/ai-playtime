<p align="center">
  <img src="assets/banner.svg" alt="ccplaytime: hours played, for Claude Code" width="100%">
</p>

# ccplaytime

Steam-style **hours played** for [Claude Code](https://code.claude.com).

```sh
npx ccplaytime
```

```
  ▶ Claude Code
    812.4 hrs on record
    34.2 hrs last two weeks  ▂▅▇█▃·▁▆█▅▂▁▃▇
    on record since 23 Jun 2025
```

## How it counts

- **Every session, once.** Each transcript event, subagents included, lands on one timeline, so parallel sessions count as wall-clock time, not double.
- **Idle time is a break.** Gaps longer than 15 minutes (WakaTime's standard) don't count.
- **Local only.** It reads `~/.claude/projects` and writes one small file, `~/.claude/ccplaytime.json`. Nothing leaves your machine. Set `CLAUDE_CONFIG_DIR` to use another directory.

## Keep your record

Claude Code deletes transcripts after 30 days, so your first run sees the last 30 days. From then on, ccplaytime saves every (UTC) day it sees: run it at least every 30 days and your record keeps growing.

To never think about it, install it and let Claude Code run it after each session, in `~/.claude/settings.json`:

```sh
npm install --global ccplaytime
```

```json
{
  "hooks": {
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "ccplaytime > /dev/null", "timeout": 60 }] }
    ]
  }
}
```

## For scripts

```sh
npx ccplaytime --json
```

```
{"hoursOnRecord":812.4,"hoursLastTwoWeeks":34.2,"onRecordSince":"2025-06-23","secondsByDay":{"2025-06-23":3600}}
```

## Develop

```sh
bun install      # also enables the pre-push hook
bun run check    # format, lint, typecheck, test, build
bun run verify   # check, plus the gate's own self-test (runs on git push)
```

## License

MIT
