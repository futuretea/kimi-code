# Glossary：fork 改名发布 @futuretea/tea-code

| term | definition | allowed_synonyms | avoid |
|------|-----------|------------------|-------|
| 上游 | `MoonshotAI/kimi-code` 仓库及其发布产物（npm 包 `@moonshot-ai/kimi-code`、CDN `code.kimi.com`、文档站、遥测端点等上游拥有的基础设施） | upstream | 官方版、原版 |
| fork | `futuretea/kimi-code` 仓库，发布分支 `futuretea` | 本仓库 | 下游 |
| fork 包 | npm 包 `@futuretea/tea-code`，本切片的交付物 | tea-code 包 | @futuretea/code（已被用户否决的旧名） |
| tea-code 三件套 | fork 身份的三个用户可见标识：bin `tea-code`、配置目录 `~/.tea-code`、环境变量 `TEA_CODE_HOME` | 身份三件套 | — |
| 身份面 | 本切片要改的标识集合：包名、bin、配置目录、`TEA_CODE_HOME`、更新检查源、发布流、npm 落地页 `apps/kimi-code/README.md` | 改名面 | 品牌（易误解为 UI 文案，UI 文案是非目标） |
| 保留面 | 用户裁决不改的上游契约集合：OAuth/平台持久化 key（`managed:kimi-code`、`oauth/kimi-code`、`kimi-code/<modelId>`）、User-Agent、遥测端点、`KIMI_CODE_*` 其余环境变量、项目级 `.kimi-code/` 目录 | 不动面 | 兼容层（不是代码层，是决策边界） |
| 版本格式 | `<fork 版本>+up<上游版本>`，首版 `0.1.0+up0.30.0`；`+up` 为 semver build metadata | +up 后缀 | 双版本号（易误解为两个独立版本） |
| base 版本 | 版本格式中 `+` 前的 semver 本体（如 `0.1.0`）；发布纪律要求每次发布必须递增，append 脚本在不递增时 fail | 版本本体 | — |
| 未发布基线 | 首发前 manifest 中的临时版本 `0.0.0`；两份已迁移的 minor changeset 将其提升到首个可发布 base `0.1.0`，之后才追加 `+up0.30.0` | first-release baseline | 已发布版本 |
| 干净切换 | 配置目录切换策略：不迁移 `~/.kimi-code`、不读取 `KIMI_CODE_HOME`，首次使用重新 login | clean switch | 无缝迁移 |
| 并存安装 | 同一台机器同时安装上游 `kimi` 与 fork `tea-code`，二者 bin、配置目录互不干扰 | 共存 | 并行安装 |
| 版本发现源 | 更新检查查询最新版本信息的来源；本切片从上游 CDN 切换为 npm registry（`@futuretea/tea-code` 的 latest）。它不包含按安装来源执行的下载或安装 transport。 | 版本源 | 升级服务器 |
| 上游内容资源 | 暂由上游控制、但本切片明确保留的 marketplace、tips banner、`fd` 资产与 native 安装 URL；它们不属于 fork 的版本发现源。 | 内容 CDN、保留资源 | 已脱离 CDN |
| native 更新限制 | fork 未拥有 native SEA 发布物时，检测到 native 安装来源不执行上游安装脚本，改提示 npm 安装 fork 包。 | native 禁用 | native 自托管 |
| 单源常量 | `apps/kimi-code/src/constant/app.ts` 中集中定义、全链路引用的身份常量（`NPM_PACKAGE_NAME` 等） | 中心出口 | — |
| 直拼点 | 绕过单源常量/中心出口、直接硬编码 `.kimi-code` 或 `KIMI_CODE_HOME` 的代码位置（12 处目录直拼 + 9 处 env 直读） | 绕路点 | — |
| 中心出口 | home 目录解析的权威实现：`agent-core/src/config/path.ts`、`agent-core-v2/bootstrap.ts`、`constant/app.ts` → `paths.ts` | home 解析中心 | — |
| 插件 env 契约 | 主进程向插件子进程注入 `KIMI_CODE_HOME`（改名后 `TEA_CODE_HOME`）、插件侧读取该变量的外部契约 | 插件环境变量 | — |
| native 发布链 | SEA 单文件二进制的构建/发布体系（`_native-build.yml`、`resolve-release.mjs` 等），本切片 out-of-scope | SEA 流程 | — |

## 边界绑定

- 「身份面」对应 goals G1-G3、G5 与影响面 in-scope 行；「保留面」对应 `clarify.md` 非目标第 2-4 条与影响面 out-of-scope 行；两者不得混用。
- 「版本发现源」对应 G2；凡写「更新检查」即指查询最新版本的链路（`src/cli/update/`），不含插件更新、tips、`fd` 下载和 native 安装 transport。
- 「干净切换」对应 G3 与 guard G-mig-1；proposal/plan 中不得出现隐式迁移逻辑。
- 「base 版本」对应 G5 与 guard G-rel-3；「版本格式」变化若只动 `+up` 后缀不视为可发布变更。
- 「未发布基线」只用于首次 release PR 的输入，不会发布到 npm；后续 release 从已发布的 `base+upstream` 版本由 Changesets 先产生更高 base。
