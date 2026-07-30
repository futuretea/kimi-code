---
name: run-kimi-code
phase: project
description: "Run, build, and drive the Tea Code CLI/TUI through a pseudoterminal smoke flow."
generated_by: auto-project-skill@1.0
generated_at: "2026-07-29T16:00:00+08:00"
metadata:
  generation_mode: full
  relationship: standalone
  priority: medium
  dependencies:
    required: []
    optional:
      - project-context
  consumes: []
  produces: []
---

# Run Tea Code

This skill runs the built Tea Code terminal UI in an isolated pseudoterminal.
The driver opens the empty session picker, checks its visible state, presses
`Esc`, and verifies the clean `Bye!` exit. It does not need a provider account
or network credentials.

## Prerequisites

Run from the repository root. This verified path requires Node.js 24.16.0,
pnpm 10.33.0, and the `expect` command available on macOS.

```bash
pnpm install --frozen-lockfile
```

## Build

```bash
pnpm -C apps/kimi-code build
```

## Run (agent path)

Run this first. The driver creates and removes a temporary `HOME` and
`TEA_CODE_HOME`, so it cannot read or modify a developer's existing Tea Code
or Kimi Code configuration.

```bash
cd apps/kimi-code
node skills/run-kimi-code/driver.mjs
```

## Test

```bash
pnpm -C apps/kimi-code exec vitest run test/cli/main.test.ts test/tui/kimi-tui-startup.test.ts
```

## Gotchas

- `expect` starts a `0×0` pseudoterminal by default. The driver sets it to
  `40×120` inside the spawned shell; otherwise the TUI negotiates terminal
  capabilities but renders no screen.
- Set both `HOME` and `TEA_CODE_HOME` to the temporary home. Setting only
  `TEA_CODE_HOME` still lets the migration probe inspect `$HOME/.kimi`.
- The normal empty-config start creates a new session and can wait in runtime
  initialization. `-S` opens the session picker instead, which gives the
  driver a deterministic no-provider interaction.

## Troubleshooting

- `Could not start expect`: install or expose the platform's `expect` command
  on `PATH`, then rerun the driver.
- `TUI smoke failed with expect exit 11`: the session picker did not show
  `No sessions found.` within 20 seconds. Rebuild the app and rerun from
  `apps/kimi-code`.
