# Tea Code

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Docs](https://img.shields.io/badge/docs-online-blue)](docs/en/) <br>
[Documentation](docs/en/) · [Issues](https://github.com/futuretea/kimi-code/issues) · [中文](README.zh-CN.md)

![Demo of using Tea Code](./docs/media/intro.gif)

## What is Tea Code

Tea Code is an AI coding agent that runs in your terminal — it can read and edit code, run shell commands, search files, fetch web pages, and choose the next step based on the feedback it receives. It works with Kimi models and other compatible providers.

## Install

Install with npm. Node.js 22.19.0 or later is required.

```sh
npm install -g @futuretea/tea-code
```

> On Windows, install [Git for Windows](https://gitforwindows.org/) before first launch because Tea Code uses the bundled Git Bash as its shell environment. If Git Bash is installed in a custom location, set `KIMI_SHELL_PATH` to the absolute path of `bash.exe`.

Then, run it with a new shell session:

```sh
tea-code --version
```

For installation, upgrade, and removal, see [Getting Started](docs/en/guides/getting-started.md).

## Quick Start

Open a project and start the interactive UI:

```sh
cd your-project
tea-code
```

On first launch, run `/login` inside Tea Code and choose either Kimi OAuth or a Moonshot AI Open Platform API key. After login, try your first task:

```
Take a look at this project and explain its main directories.
```

## Key Features

- **npm distribution.** Install or upgrade through the `@futuretea/tea-code` package.
- **Blazing-fast startup.** The TUI is ready in milliseconds, so starting a session never feels heavy.
- **Purpose-built TUI.** A carefully tuned interface, optimized end to end for long, focused agent sessions.
- **Video input.** Drop a screen recording or demo clip into the chat and let the agent watch what is hard to describe in words — turn a reference clip into a LUT, a long video into a short, a screen recording into working code, and more.
- **AI-native MCP configuration.** Add, edit, and authenticate Model Context Protocol servers conversationally with `/mcp-config`, without hand-editing JSON.
- **Rich plugin ecosystem.** Install skills, MCP servers, and data sources from the marketplace or any GitHub repo, with each install's trust level surfaced up front.
- **Subagents for focused, parallel work.** Dispatch built-in `coder`, `explore`, and `plan` subagents in isolated contexts while keeping the main conversation clean.
- **Lifecycle hooks.** Run local commands at key points to gate risky tool calls, audit decisions, trigger desktop notifications, or connect to your own automation.
- **Editor & IDE integration (ACP).** Drive a Tea Code session straight from Zed, JetBrains, or any [Agent Client Protocol](https://agentclientprotocol.com/) client with `tea-code acp`.

## Use it in your editor (ACP)

Tea Code speaks the [Agent Client Protocol](https://agentclientprotocol.com/), so ACP-compatible editors and IDEs (Zed, JetBrains, …) can drive a session over stdio. Log in once, then point your editor at the `tea-code acp` subcommand — no extra login needed.

For Zed, add this to `~/.config/zed/settings.json`:

```json
{
  "agent_servers": {
    "Tea Code": {
      "type": "custom",
      "command": "tea-code",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

Then open a new conversation in Zed's Agent panel. See [Using in IDEs](docs/en/guides/ides.md) for JetBrains setup and troubleshooting, and the [`tea-code acp` reference](docs/en/reference/kimi-acp.md) for the full capability matrix.

## Docs

- [Getting Started](docs/en/guides/getting-started.md)
- [Interaction and approvals](docs/en/guides/interaction.md)
- [Sessions](docs/en/guides/sessions.md)
- [Using in IDEs (ACP)](docs/en/guides/ides.md)
- [Configuration](docs/en/configuration/config-files.md)
- [Command reference](docs/en/reference/kimi-command.md)

## Develop

Requirements: Node.js ≥ 24.15.0, pnpm 10.33.0.

```sh
git clone https://github.com/futuretea/kimi-code.git
cd kimi-code
pnpm install
```

```sh
pnpm dev:cli    # run the CLI in dev mode
pnpm test       # run tests
pnpm typecheck  # TypeScript check
pnpm lint       # oxlint
pnpm build      # build all packages
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contribution guide.

## Community

- [Issues](https://github.com/futuretea/kimi-code/issues)
- For security vulnerabilities, see [SECURITY.md](SECURITY.md).

## Acknowledgements

Our TUI is built on top of [`pi-tui`](https://github.com/earendil-works/pi-mono/tree/main/packages/tui). We thank the authors of `pi-tui` for their valuable work.

## License

Released under the [MIT License](LICENSE).
