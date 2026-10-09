# 从 kimi-cli 迁移

::: info
Tea Code CLI 使用 Kimi Code 的 Node.js 实现，通过 npm 的 `@futuretea/tea-code` 包分发。你可以主动导入旧版 Python/uv kimi-cli 的数据。
:::

如果你正在从旧版迁移，按照以下步骤操作——一条命令就能把配置、MCP server 与会话历史一并迁移至新版。

## 新版优势

- **不再依赖 Python / uv**：基于 Node.js 重写，无需配置 Python 环境，安装更简单
- **npm 发行**：通过 npm 或 pnpm 安装，见[开始使用](./getting-started.md)
- **终端界面全面重设计**：交互体验更流畅
- **数据可完整迁移**：配置、MCP、会话历史一键带走，无缝延续

## 如何迁移

正常启动 Tea Code 不会检查 `~/.kimi/` 或提示自动迁移。如需导入旧数据，请**主动执行迁移命令**：

源目录默认为 `~/.kimi/`；`KIMI_SHARE_DIR` 保留指定旧版源目录的原有语义。导入的数据写入 `TEA_CODE_HOME`，未设置时写入 `~/.tea-code/`。

```sh
tea-code migrate
```

你可以选择是否同时迁移聊天会话。如果暂时不需要历史记录，选 **Config only**；否则选 **Config + N sessions** 一并迁移。结束后会显示结果摘要。

## 迁移会发生什么

**会被迁移的内容**：配置（`config.toml`）、MCP 服务配置、输入历史，以及你选择迁移的聊天会话。

**不会被迁移的内容**：OAuth 登录凭证和 MCP 服务的授权都不会被复制，迁移后需要在 Tea Code 里重新执行 `/login` 和重新授权 MCP 服务。kimi-cli 的插件也不在迁移范围内。

::: tip 提示
主动迁移不会删除旧版配置或会话数据，但可能在源目录写入或更新 `.migrated-to-kimi-code` 完成标记。kimi-cli 仍可照常使用。迁移可以重复运行，已经迁移过的会话不会被重复导入。
:::

迁移完成后，从 kimi-cli 导入的会话会带上 `[imported]` 标记，方便你与新建的会话区分。
