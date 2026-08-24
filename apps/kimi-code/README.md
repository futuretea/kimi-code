# @futuretea/tea-code

Tea Code is a terminal AI coding agent. It runs against compatible Kimi providers while keeping its user-global data separate from Kimi Code.

## Install

Tea Code is distributed through npm. Use Node.js 22.19.0 or later:

```sh
npm install -g @futuretea/tea-code
```

Or with pnpm:

```sh
pnpm add -g @futuretea/tea-code
```

Start a new terminal session, then verify the install:

```sh
tea-code --version
```

Tea Code stores user-global settings, sessions, and logs in `$TEA_CODE_HOME`, defaulting to `~/.tea-code`. It does not read or write Kimi Code's user-global directory. Project-local `.kimi-code` files are unchanged for provider compatibility.

## Quick start

```sh
cd your-project
tea-code
```

Run `/login` on first launch and select a supported Kimi authentication method or provider.

## Repository and issues

- Source: https://github.com/futuretea/kimi-code
- Issues: https://github.com/futuretea/kimi-code/issues

## License

MIT
