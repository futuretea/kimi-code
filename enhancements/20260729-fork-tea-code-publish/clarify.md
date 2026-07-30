# Clarify：fork 改名发布 @futuretea/tea-code

## 问题陈述

`futuretea/kimi-code` 是 `MoonshotAI/kimi-code` 的 fork，工作分支 `futuretea`。上游以 `@moonshot-ai/kimi-code` 发布 npm 包（bin `kimi`、配置目录 `~/.kimi-code`、环境变量 `KIMI_CODE_HOME`、版本检查打上游 CDN）。fork 需要以独立身份 `@futuretea/tea-code` 发布自己的 npm 包，使用户可以 `npm i -g @futuretea/tea-code` 安装并用 `tea-code` 命令运行，且身份、更新检查、配置目录与上游不混淆。

## 目标

| id | goal | verification_type | signal_or_metric | target_or_condition | verification_method | evidence_source |
|----|------|-------------------|------------------|---------------------|---------------------|-----------------|
| G1 | fork 可以 `@futuretea/tea-code@0.1.0+up0.30.0` 发布并被安装运行 | acceptance_signal | `npm i -g @futuretea/tea-code` 成功后 `tea-code --version` 输出含 `0.1.0+up0.30.0`，TUI 可启动且用户可见恢复指引只给出 `tea-code` 命令与 `~/.tea-code` 路径 | 安装、版本输出、启动和恢复指引四项全部成功；首次 release 从未发布基线 `0.0.0` 经已迁移的 pending changesets 生成 `0.1.0`，再追加 `+up0.30.0` | 首次 GHA 发布后真实全局安装；发布前对声明的 baseline/changeset fixture 执行 `version:release` 干跑、对既有 CLI/core 测试断言运行时指引，再做 `pnpm build` + `npm pack` + 本地安装预演 | 命令输出、fixture 输出、测试输出、npm registry |
| G2 | 版本发现源指向 fork 自身的 npm registry 记录 | acceptance_signal | CLI 的版本发现（含 `upgrade` 的查询步骤）查询 npm registry 的 `@futuretea/tea-code`；不再请求上游 CDN 的版本元数据、不再使用上游包名 | 版本发现链路只请求 npm registry；marketplace、tips、`fd` 下载与安装 transport 不属于本目标，按保留面单列 | 代码检查（常量与 update 链路）+ 单测/运行时干跑 | 源码与测试证据 |
| G3 | 配置目录与环境变量切换为 `~/.tea-code` / `TEA_CODE_HOME` | acceptance_signal | 干净 HOME 下启动后读写 `~/.tea-code`；设置 `TEA_CODE_HOME` 时优先生效；不再创建/读写 `~/.kimi-code` | 三条信号全部成立 | 临时 `HOME` 启动 CLI 观察目录创建与读写路径 | 命令输出 |
| G4 | GHA 发布流在 `futuretea` 分支可用（OIDC trusted publisher） | acceptance_signal | push 到 `futuretea` 触发 release.yml，owner 守卫通过，changesets 发布成功且 npm 上可见新版本 | 首次真实发布 run 成功 | GHA run 日志 + `npm view @futuretea/tea-code` | GHA 日志、npm registry |
| G5 | 版本号格式 `<fork 版本>+up<上游版本>` 可持续维护 | acceptance_signal | package.json version 为 `0.1.0+up0.30.0`；后续 changeset 版本流自动维持 `+up` 后缀；每次发布 base 版本必须递增（仅 `+up` 变化时 release 编排脚本 fail） | 首次版本正确、版本脚本可复算且 up-only 场景被拦截 | 本地执行 `version:release` 干跑核对输出（含 first-release fixture、后续 minor fixture、base 未递增用例） | package.json、脚本输出 |

## 非目标

- 不改 20 个内部 private workspace 包的包名（`@moonshot-ai/*`；被 tsdown 整体 bundle，不进 npm 产物）。
- 不改 OAuth、平台、遥测等对上游 Kimi 服务的既有契约：`managed:kimi-code` / `oauth/kimi-code` / `kimi-code/<modelId>` 持久化 key、`X-Msh-Platform`、OAuth clientId（evidence：改名会破坏存量用户配置与凭证）。
- 不改发往上游服务的 User-Agent（CLI / kap-server 为 `kimi-code-cli`，vscode 为 `kimi-code-vscode`）与遥测端点（`telemetry-logs.kimi.com`）——user_override 裁决保留。
- 不改项目级 `.kimi-code/` 目录（`mcp.json`、`local.toml`、`AGENTS.md`）与 `KIMI_CODE_*` 其余环境变量（`KIMI_CODE_BASE_URL`、`KIMI_CODE_OAUTH_HOST`、`KIMI_CODE_EXPERIMENTAL_*` 等）——仅 `KIMI_CODE_HOME` 改 `TEA_CODE_HOME`。
- 不迁移用户已有 `~/.kimi-code` 数据，不读取旧 `KIMI_CODE_HOME`（干净切换，首次使用重新 login）。
- 不改 TUI 界面品牌文案、`apps/kimi-code` 目录名、vscode 扩展品牌。
- 不做 native SEA 二进制发布流；release.yml 中 native jobs 与 deploy-docs 裁掉。检测到 native 安装来源时不执行上游安装脚本，改提示通过 npm 安装 fork 包。
- 不同步修改上游文档站内容（docs/）、插件 marketplace 内容、tips 内容、`fd` 上游资产、git remote / 分支结构 / commit 历史；这些上游资源暂时保留为外部依赖。

## 成功标准

G1-G5 全部达成；首次发布后 `npm view @futuretea/tea-code` 可见 `0.1.0+up0.30.0`；`tea-code` 与上游 `kimi` 可在同一台机器并存安装且配置互不干扰。

## 决策树

```
发布方式？── GHA OIDC（用户确认）── trusted publisher 配置（仓库外，用户操作）
包名？────── @futuretea/tea-code（用户改口确认，覆盖最初 @futuretea/code）
命名？────── bin tea-code / ~/.tea-code / TEA_CODE_HOME（用户确认）
版本？────── 0.1.0+up0.30.0（用户确认）── +up 后缀由 version:release 拼接（实现决策）
发布分支？── futuretea（用户确认）── release.yml 触发分支与 changesets baseBranch 同步改
版本发现源？─ npm registry（用户确认）── 仅替换 latest 元数据查询，灰度 rollout 元数据退化
内容资源？─── 上游 CDN 暂时保留（用户确认）── marketplace / tips / fd 资产不自托管
native 更新？── 检测到 native 时禁用上游脚本（用户确认）── 提示 npm 安装 fork；原生发布另立 enhancement
配置迁移？── 干净切换（用户确认）── 不迁移、不读旧 env，重新 login
UA/遥测？── 全部保留（用户 override）── 风险已记录
列外项？── 项目目录与其余 env 前缀不改（用户确认）
```

## Design Interview 摘要

mode=completed。10 条用户确认答案（6 条 align 转录 + 4 条影响面裁决），0 条未决。完整证据链见 `design-interview.md`。

## 已确认答案摘要

1. 发布方式：GitHub Actions OIDC trusted publisher（user_confirmed）。
2. 改名范围：包名、更新检查源、bin、配置目录全换（user_confirmed）。
3. 命名：bin `tea-code`、`~/.tea-code`、`TEA_CODE_HOME`（user_confirmed）。
4. 包名：`@futuretea/tea-code`（user_override，覆盖 `@futuretea/code`）。
5. 版本号：`0.1.0+up0.30.0` 格式（user_confirmed）。
6. 发布分支 `futuretea`；用户已持 `@futuretea` scope 并可配 trusted publisher（user_confirmed）。
7. 版本发现改查 npm registry；非版本上游 CDN 资源暂时保留（user_confirmed）。
8. 配置目录干净切换：不迁移、不读旧 env（user_confirmed）。
9. UA 与遥测端点全部保留（user_override，风险已记录）。
10. 项目级 `.kimi-code/` 目录与其余 `KIMI_CODE_*` 环境变量不改（user_confirmed）。
11. marketplace、tips、`fd` 资产与 native 安装 URL 暂时保留上游来源；本切片不自托管（user_confirmed）。
12. fork 未拥有 native SEA 发布物时，native 安装来源不得执行上游安装脚本，提示使用 npm 安装 fork 包（user_confirmed）。
