# @futuretea/tea-code

> The Starting Point for Next-Gen Agents

[![npm](https://img.shields.io/npm/v/@futuretea/tea-code)](https://www.npmjs.com/package/@futuretea/tea-code) [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)  [![Docs](https://img.shields.io/badge/docs-online-blue)](https://moonshotai.github.io/kimi-code/en/)

## What is Tea Code CLI

Tea Code CLI is an AI coding agent that runs in your terminal. It can read and edit code, run shell commands, search files, fetch web pages, and choose the next step based on the feedback it receives. It works out of the box with Moonshot AI's Kimi models and can also be configured to use other compatible providers.

## Install

Requires Node.js 22.19.0 or later. Install with npm:

```sh
npm install -g @futuretea/tea-code
tea-code --version
```

On Windows, install Git for Windows; custom Git Bash paths still use `KIMI_SHELL_PATH`.

Tea Code 0.4.0 corresponds to Kimi Code 0.41.0. User state lives in `TEA_CODE_HOME` or `~/.tea-code`, independently of upstream installations. The browser Web UI retains Kimi Code branding.

## Quick Start

Open a project and start the interactive UI:

```sh
cd your-project
tea-code
```

On first launch, run `/login` inside Tea Code CLI and choose either Kimi Code OAuth or a Kimi Platform API key. After login, try a first task:

```
Take a look at this project and explain the main directories.
```

## Key Features

- **npm distribution.** Install the `tea-code` command independently of upstream Kimi Code.
- **Blazing-fast startup.** The TUI is ready in milliseconds, so opening a session never feels heavy.
- **Polished TUI.** A carefully tuned interface designed for long, focused agent sessions.
- **Video input.** Drop a screen recording or demo clip into the chat — let the agent watch instead of typing out what's hard to describe in words.
- **AI-native MCP configuration.** Add, edit, and authenticate Model Context Protocol servers conversationally via `/mcp-config` — no hand-editing JSON.
- **Subagents for focused, parallel work.** Dispatch built-in `coder`, `explore`, and `plan` subagents in isolated context windows; the main conversation stays clean.
- **Lifecycle hooks.** Run local commands at key points — gate risky tool calls, audit decisions, fire desktop notifications, wire into your own automation.

## Documentation

- Full docs: https://moonshotai.github.io/kimi-code/en/
- 中文文档: https://moonshotai.github.io/kimi-code/zh/
- Getting Started: https://moonshotai.github.io/kimi-code/en/guides/getting-started

## Repository & Issues

- Source: https://github.com/futuretea/kimi-code
- Issues: https://github.com/futuretea/kimi-code/issues
- Security: see SECURITY.md in the main repository

## License

MIT
