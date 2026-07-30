# @futuretea/tea-code

> A terminal AI coding agent

[![npm](https://img.shields.io/npm/v/@futuretea/tea-code)](https://www.npmjs.com/package/@futuretea/tea-code) [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## What is Tea Code?

Tea Code is an AI coding agent that runs in your terminal. It can read and edit code, run shell commands, search files, fetch web pages, and choose the next step based on the feedback it receives. It works out of the box with Kimi models and can also be configured to use other compatible providers.

## Install

Install with npm or pnpm. Tea Code requires Node.js 22.19.0 or later.

```sh
npm install -g @futuretea/tea-code
```

Or:

```sh
pnpm add -g @futuretea/tea-code
```

On Windows, install [Git for Windows](https://gitforwindows.org/) before first launch because Tea Code uses the bundled Git Bash as its shell environment. If Git Bash is installed in a custom location, set `KIMI_SHELL_PATH` to the absolute path of `bash.exe`.

Verify the installation:

```sh
tea-code --version
```

## Quick Start

Open a project and start the interactive UI:

```sh
cd your-project
tea-code
```

On first launch, run `/login` inside Tea Code and choose either Kimi OAuth or a Kimi Platform API key. After login, try a first task:

```
Take a look at this project and explain the main directories.
```

## Key Features

- **npm distribution.** Install Tea Code globally with npm or pnpm.
- **Blazing-fast startup.** The TUI is ready in milliseconds, so opening a session never feels heavy.
- **Polished TUI.** A carefully tuned interface designed for long, focused agent sessions.
- **Video input.** Drop a screen recording or demo clip into the chat — let the agent watch instead of typing out what's hard to describe in words.
- **AI-native MCP configuration.** Add, edit, and authenticate Model Context Protocol servers conversationally via `/mcp-config` — no hand-editing JSON.
- **Subagents for focused, parallel work.** Dispatch built-in `coder`, `explore`, and `plan` subagents in isolated context windows; the main conversation stays clean.
- **Lifecycle hooks.** Run local commands at key points — gate risky tool calls, audit decisions, fire desktop notifications, wire into your own automation.

## Repository & Issues

- Source: https://github.com/futuretea/kimi-code
- Issues: https://github.com/futuretea/kimi-code/issues
- Security: see SECURITY.md in the main repository

## License

MIT
