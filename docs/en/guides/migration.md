# Migrating from kimi-cli

::: info
Tea Code CLI uses the Node.js implementation of Kimi Code and is distributed as `@futuretea/tea-code` through npm. You can explicitly import data from the legacy Python/uv kimi-cli.
:::

If you are migrating from the legacy version, follow the steps below — a single command migrates your config, MCP servers, and session history to the new version.

## What's new

- **No more Python / uv**: Rebuilt on Node.js — no Python environment needed, simpler to install
- **npm distribution**: Install with npm or pnpm; see [Getting started](./getting-started.md)
- **Redesigned terminal UI**: Smoother, more responsive experience
- **Full data migration**: Config, MCP servers, and session history all carry over seamlessly

## How to migrate

Normal Tea Code startup does not inspect `~/.kimi/` or offer automatic migration. To import legacy data, **run the migration command explicitly**:

The source defaults to `~/.kimi/`; `KIMI_SHARE_DIR` retains its legacy source-directory behavior. Imported data goes to `TEA_CODE_HOME`, or `~/.tea-code/` when unset.

```sh
tea-code migrate
```

You can choose whether to migrate chat sessions as well. If you don't need the history yet, pick **Config only**; otherwise pick **Config + N sessions** to bring everything across in one go. A summary is printed at the end.

## What happens during migration

**What gets migrated**: configuration (`config.toml`), MCP server configuration, input history, and whichever chat sessions you chose to migrate.

**What does not get migrated**: OAuth login credentials and MCP service authorizations are not copied, so you will need to run `/login` again and re-authorize MCP servers after migrating. kimi-cli plugins are also out of scope.

::: tip
Explicit migration does not delete the legacy config or session data. It can write or update the `.migrated-to-kimi-code` completion marker in the source directory. kimi-cli remains usable. Migration can also be run repeatedly — sessions that have already been migrated are not imported again.
:::

After migration, sessions imported from kimi-cli are tagged with `[imported]` in the session picker so you can tell them apart from new ones.
