# fork 改名发布 @futuretea/tea-code 实现方案

## 产物状态

| 字段 | 值 |
|---|---|
| 产物状态 | `delivered` |
| 审查门禁 | `pass` |
| Skill 标注 | `complete` |
| 最新审查证据 | `.auto-runs/v2/auto-plan/20260729-auto-plan-fork-tea-code-publish-r4/fresh-full-scope-review-round-4.md` |
| 阻塞项 | `none` |

## 概述

本切片交付可发布的 `@futuretea/tea-code@0.1.0+up0.30.0`：npm、`tea-code`、`TEA_CODE_HOME`、用户全局 `~/.tea-code`、更新发现和发布/Nix 分发统一为 Tea 身份。实现从 T1 的包与版本契约开始，首个验证是版本 fixture 的 Red 测试。

不迁移旧 home，不读取旧 `KIMI_CODE_HOME`，不改项目级 `.kimi-code`、OAuth/平台 persistence key、UA/遥测、docs site、vscode 品牌、native SEA 发布或 `third-party-projects/`。

## 实现入口

| 项 | 内容 |
|---|---|
| 当前切片 | fork 的 npm、CLI、用户全局 home、更新和发布/Nix 分发身份切换，并完成首次发布前可复现验证。 |
| 允许修改范围 | `apps/kimi-code/`、`apps/kimi-inspect/`、`apps/vis/server/`、`packages/{agent-core,agent-core-v2,oauth,migration-legacy,klient,minidb}/`、`plugins/official/kimi-datasource/`、根 `package.json`/`scripts/`/`.changeset/`/`.github/workflows/`/`flake.nix`，以及这些模块的就近测试。 |
| 禁止触碰范围 | `third-party-projects/`、`docs/**`、`apps/vscode/`、项目级 `.kimi-code`、其余 `KIMI_CODE_*`、OAuth/平台 key、UA/遥测、native SEA scripts 与上游资源自托管。 |
| 入口任务 | T1：包元数据与可复现 `+up` 发版编排。 |
| 首个验证命令 | 新增 `apps/kimi-code/test/cli/version-release.test.ts` 与 `apps/kimi-code/test/fixtures/version-release/{first-release,subsequent-release,old-selector,base-not-incremented}` 后，运行 `pnpm -C apps/kimi-code exec vitest run test/cli/version-release.test.ts`；该测试把 fixture 复制到临时根目录，调用 `node scripts/version-release.mjs --root <temp-root>`，并在 `afterEach` 删除临时目录。Red 阶段因脚本不存在失败；首发 fixture Green 后得到 `0.1.0+up0.30.0`，subsequent fixture 从已发布版本加新 minor 得到 `0.2.0+up0.30.0`。 |
| 阻塞条件 | npm trusted publisher、包名可用性或 GHA OIDC 未通过发布前 checklist；任何身份 sweep 命中没有变更或确认保留理由；Nix `tea-code` build 不可复现。 |
| 最小实现约束 | 复用现有 constants、home resolvers、Node 内置 `fetch`、Changesets、Vitest 与 Nix workspace checker；不新增依赖、兼容 alias、公共 API、配置项、home 解析层、状态机或 native 发布物。 |

用户于 2026-07-29 确认：Nix 对外 attr 和主程序也改为 Tea 身份。该决定覆盖 `flake.nix` 的 app package attr、`pname`、`mainProgram` 与安装输出；不等同于恢复 native SEA 发布。

## 架构与职责

```text
package.json / Changesets / version-release.mjs
                 │
                 ▼
@futuretea/tea-code + tea-code ──► app constants ──► home / plugin / ACP / user copy
                 │                        │
                 │                        ├──► npm registry version discovery
                 │                        └──► native source: npm guidance only
                 ▼
release.yml + OIDC + flake.nix ──► npm package / Nix tea-code program
```

| 模块 | 职责 | 关键边界 |
|---|---|---|
| `apps/kimi-code/src/constant` 与 `src/utils/paths.ts` | CLI 常量与 app-owned home 路径的单一入口 | 只改全局 Tea 身份；不改 UA/telemetry。 |
| `packages/agent-core*`、`packages/oauth`、plugin/ACP | 解析同一 Tea home 并透传给受控子进程 | 不读取旧 env，不改项目 local config 或 persistence key。 |
| `apps/kimi-code/src/cli/update` | npm registry 版本发现、缓存 provenance 与安装来源行为 | 缓存写入 `source: 'npm-registry'`、`manifest: null`；旧 CDN cache 丢弃而不迁移；内容资源仍用上游 URL；native 来源只显示 npm 指令。 |
| release/Changesets/Nix | 首发版本、OIDC、fork workflow 和 Nix program | OIDC 保留；不发布 docs/native SEA。 |
| 文案、bundled skill、migration、开发工具 | 用户可复制路径和命令的 Tea identity | 显式保留项目路径与历史迁移术语。 |

## 目录与文件边界

| 位置 | 本切片动作 |
|---|---|
| `apps/kimi-code/` | 包/bin、postinstall、全局 home、CLI 更新、TUI/CLI 文案、bundled skills 与其测试。 |
| `apps/kimi-inspect/`、`apps/vis/server/` | 只调整 app-owned 默认 home 或用户可见恢复路径，并补就近测试。 |
| `packages/agent-core/`、`packages/agent-core-v2/`、`packages/oauth/`、`packages/migration-legacy/` | Tea home 解析、builtin skill 文案与 migration target；不改 OAuth/persistence key。 |
| `packages/klient/`、`packages/minidb/`、`plugins/official/kimi-datasource/` | 开发工具默认输入及受控子进程 Tea env；不新增第三方 alias。 |
| 根 `package.json`、`scripts/`、`.changeset/`、`.github/workflows/`、`flake.nix` | 版本、发布、fork workflow 与 Tea Nix 分发；不改 docs/native SEA 脚本。 |

扩展点为 `not-applicable`：当前切片不需要稳定的新接口。npm registry 是既有 HTTP 调用的替换，不引入 provider abstraction；未来自建版本源或 native 分发另开 enhancement。

## 完备性与外部依赖

### 残留清单

本切片移除公开接口，残留清单为 [residual-inventory.md](../../.auto-runs/v2/auto-plan/20260729-auto-plan-fork-tea-code-publish-r2/residual-inventory.md)。T7 必须按其八个族逐项对账，并对清单列出的稳定交付集合反向抽查；不得扫描 `enhancements/`、`.auto-runs/` 或其它非交付证据。项目 `.kimi-code`、OAuth/平台 key、UA/遥测、`kimi-cli` 历史 marker 的命中必须按 A1--A5 有限 allowlist 记录保留理由，不能机械替换。

| 残留族 | 扫描口径 | 处置结论 |
|---|---|---|
| 代码标识符 | `NPM_PACKAGE_NAME`、`CLI_COMMAND_NAME`、`KIMI_CODE_HOME`、`.kimi-code`、`resolveKimiHome` | 改全局 home/env 与 fork package/bin；项目路径、OAuth/平台 key、历史 marker、UA/遥测保留并逐项记理由。 |
| 指标与观测 | `kimi-code-cli`、telemetry endpoint、`FEEDBACK_*`、`KIMI_CODE_*` | 保留 UA/遥测及其余 `KIMI_CODE_*`，不得借身份 sweep 改变观测语义。 |
| 用户可见文案与 i18n | bundled skill、TUI/API-key/config/export、recovery、migration、proxy、Inspector、postinstall | 全局路径、可复制命令和 fork npm 指令改 Tea；项目路径、历史 Python marker、上游服务标识保留，改动均补就近断言。 |
| 配置与部署 | manifest、changesets、release workflow、Nix workspace/checker/derivation | 改包/bin/repository、版本编排、owner/branch/filter、OIDC provenance 和 Tea Nix attr/main program；只删 release docs/native job。 |
| 角色、权限与枚举 | release owner、OIDC permission、install-source enum | owner 改 `futuretea`；保留 `id-token: write` 与 provenance；native 改 npm 指引，不新增 source 或 fallback 状态机。 |
| API / 外部契约 | npm package、`tea-code`、`TEA_CODE_HOME`、plugin/ACP env、Nix attr/main program | 全部改 Tea；项目路径、OAuth/平台 persistence key、User-Agent 保留；第三方旧 env 是已知限制且无 alias。 |
| 测试资产 | paths/ACP/update/postinstall/CLI/TUI、两 engine、OAuth、migration、Inspector、klient/minidb、version/Nix | 先更新/新增行为测试；对旧默认路径、npm 指令、selector、native installer 均写负向断言；保留字面量写明理由。 |
| 文档与示例 | app README、bundled body、klient examples、minidb bench、`.changeset/README.md`；`docs/**`、vscode 文档 | T1 改 npm README，T4 改 bundled guidance，T5 改开发工具默认输入，T6 改 Changesets 发布指引；docs site、vscode 和一般上游文档为非目标。 |

### Guard Policy 映射

| Guard | 落点 |
|---|---|
| G-rel-1 owner guard | T6 修改 `release.yml`，发布前人工确认 owner 为 `futuretea`。 |
| G-rel-2 OIDC provenance | T6 保留 `publishConfig.provenance` 与 release job 的 `id-token: write`；首次发布人工核验。 |
| G-fb-1 registry 不可达 | T3 单测确认版本检查静默跳过，不阻断 CLI。 |
| G-mig-1 干净切换 | T2/T5 覆盖默认与显式 `TEA_CODE_HOME`，断言不读写旧 home。 |
| G-mig-2 postinstall ownership | T1 的 fork postinstall 在进入 legacy `kimi` 检测/接管前直接 no-op；任何既有 `kimi` npm/Python shim 均不扫描、不改名、不删除。此为既有 ownership 判定正确性修复，不新增 alias、fallback 或阻断 guard。 |
| G-rel-3 base 递增 | T1 fixture 拒绝旧 selector 或仅改 upstream suffix；T6 发布前 dry run。 |
| G-fb-2 native 安装来源 | T3 测试保证不执行上游脚本，只给 npm 安装指引。 |

### 外部环境数据依赖

| 依赖 | plan 动作 | 证据与失败处理 |
|---|---|---|
| npm `@futuretea` scope 与 trusted publisher | T6 release gate / manual verification | 发布前在 npm trusted publisher 设置中确认 repository=`futuretea/kimi-code`、workflow=`.github/workflows/release.yml`；任一不匹配即停止并记录设置截图/链接，不以 token fallback 发布。 |
| `@futuretea/tea-code` 包名可用性 | T6 release gate | 首发前 `npm view @futuretea/tea-code` 的 E404 是唯一预期 pass（名字未占用）；exit 0/返回已有 package 是 collision，非 E404 错误是网络或认证失败，均停止并记录输出，修正或恢复后从此 gate 重试。 |
| GitHub/npm OIDC 公共基础设施 | T6 manual verification | pass=release job 的 OIDC publish step 成功且随后 `npm view @futuretea/tea-code version dist.tarball` 返回本次 `0.1.0+up0.30.0`；OIDC/auth/network/publish 或 registry 校验失败均停止、不降级为 token 发布，并保留 workflow run 与 npm view 输出。 |
| 上游 marketplace、tips、`fd`、native URL | T3 unit tests + non-goal | 保持 URL consumer 的既有测试；native URL 可保留为内容资源，但不得由 update 执行上游安装器。 |

## 测试策略

所有行为变更先执行 Red → Green → Refactor。外部 npm/GHA 不在共享或生产环境自动执行；它们采用「降级+替代验证」：trigger=需要首发，scope=registry/OIDC，substitute_verification=本地 pack/install、workflow/static gate 与 npm view，residual_risk=真实发布仍需维护者人工证据。

| 任务 | TDD 结论 | 首个失败测试 / 最小场景 | 验证层次与命令 |
|---|---|---|---|
| T1 | `tdd-required` | `apps/kimi-code/test/cli/version-release.test.ts` 以 `test/fixtures/version-release/{first-release,subsequent-release,old-selector,base-not-incremented}` 临时副本执行：0.0.0 + 两个 fork minor selector → `0.1.0+up0.30.0`；已发布 `0.1.0+up0.30.0` + 新 minor → `0.2.0+up0.30.0`；old selector、base 未递增各失败且不写版本。另在 `apps/kimi-code/test/postinstall/ownership.test.ts` 的临时 shim fixture 中预置 upstream npm `kimi` 与 Python `kimi_cli`，运行 fork postinstall 后断言其路径和字节均不变。 | `pnpm -C apps/kimi-code exec vitest run test/cli/version-release.test.ts test/postinstall/ownership.test.ts`。 |
| T2 | `tdd-required` | `app.ts` 的 package/bin/home 单源常量为 Tea；默认 home 为 `~/.tea-code`；`TEA_CODE_HOME` 优先；plugin/ACP 只透传 Tea env。 | app `paths.test.ts` 的单源常量与路径断言，加 v1、v2、OAuth、plugin/ACP focused Vitest。 |
| T3 | `tdd-required` | registry refresh 写入并重读 `{ source: 'npm-registry', latest, manifest: null }`；旧 `source: 'cdn'` cache 与旧 persisted `homebrew` install state 都丢弃；网络/非法版本静默跳过且不覆写 cache；fork 不输出或执行 Homebrew/native 上游 script。 | `apps/kimi-code/test/cli/update/{cache,cdn,refresh,select,source,preflight,install-state,rollout}.test.ts`。 |
| T4 | `tdd-required` | 八份 bundled body 的用户全局路径/环境变量为 Tea，项目 `.kimi-code` 仅在允许位置存在。 | agent-core / agent-core-v2 skill catalog tests。 |
| T5 | `tdd-required` | conflict notice 使用 `input.target`；`export --help`、恢复命令和静态 home 文案不含旧全局路径/命令。 | app、migration、Inspector、klient、minidb、core focused tests。 |
| T6 | `tdd-not-applicable` | workflow/YAML、Changesets、Nix attr 是声明与接线，不含可独立的业务逻辑。 | `node scripts/check-nix-workspace.mjs`、`nix build .#tea-code`、`test -x result/bin/tea-code`、`nix run .#tea-code -- --version`、workflow review、release dry run。 |
| T7 | `tdd-not-applicable` | 这是跨任务验收聚合，不新增生产逻辑。 | 定向测试汇总、build/typecheck/lint、pack/install、full sweep、Nix app/bin 运行断言和首次发布人工证据。 |

### T3/T6 安全专项复核

T3、T6 的 Green 验证之后、T7 聚合验收之前，委派独立 `$[review-security]` 做一次 deep 专项审查。范围限于 T3 的 npm registry 响应解析、native 来源 no-spawn、更新诊断，以及 T6 的 OIDC/provenance、release workflow 与日志；不读取 `third-party-projects/`。审查以现有代码、测试和 workflow 为证据，检查外部输入解析、上游脚本未执行、OIDC/provenance 未被削弱和诊断不输出 secret。P0/P1 回到对应任务修复并重审；不因审查建议新增 guard，任何 validation/fallback/release guard 的语义改变仍先走 `$[guard-policy]` 和适用的人类决策。

## 任务 DAG

```text
T1 ──┬──► T3 ──┐
     └──► T6 ──┤
T2 ──┬──► T3 ──┤
     ├──► T4 ──┼──► T7
     └──► T5 ──┘
```

| ID | 是否新增代码与复用 | 最小可运行检查 |
|---|---|---|
| T1 | 新增只做版本推导的 `scripts/version-release.mjs`；新增 `apps/kimi-code/test/cli/version-release.test.ts` 及其四份 fixture；在既有 postinstall orchestrator 中让 fork 在 legacy `kimi` 检测/接管前 no-op，新增 `apps/kimi-code/test/postinstall/ownership.test.ts` 的隔离 `kimi` npm/Python fixture；同步更新 `apps/kimi-code/scripts/smoke.mjs` 的 CLI usage expectation。测试在 `mkdtemp` 的隔离根目录执行脚本的私有 `--root` fixture 入口，`afterEach` 删除目录；生产 `version:release` 不传该参数。复用 Changesets、现有 version command 与 Node 标准库，不引入版本框架；同步改随 npm 发布的 README。 | 先运行 `pnpm -C apps/kimi-code exec vitest run test/cli/version-release.test.ts test/postinstall/ownership.test.ts`；version fixture 覆盖首发、成功 subsequent release、old selector 与不递增 base，并断言失败不写文件；postinstall fixture 断言预置的 `kimi` / `kimi_cli` 路径与字节不变；跑 app smoke、`pnpm lint:pkg` 后用 `npm --prefix apps/kimi-code pack --dry-run --json` 检查 CLI tarball 的 README、fork 包名、安装命令与仓库链接。 |
| T2 | 唯一 owner：改既有 `app.ts` package/bin/home 单源 constants、home resolver 和 env 传播点；复用现有 resolver，不新增 home abstraction。 | `paths.test.ts` 先直接断言 package/bin/home 常量，再覆盖默认与 `TEA_CODE_HOME` 两路只读写 Tea home。 |
| T3 | 改既有 update 模块、cache schema/reader/writer、install-state schema 和其 fork 仓库链接；只消费 T2 已落地的 app constant，复用 Node 内置 `fetch` 和现有 source enum，不建 registry client 或 fallback 状态机。registry cutover 后严格写/读 `source: 'npm-registry'` 与 `manifest: null`；旧 CDN cache 与带 `homebrew` 的 persisted install state 都视为无效并丢弃，不迁移、不兼容、不输出或执行 Homebrew command。 | registry refresh cache round-trip、旧 CDN cache 丢弃、旧 Homebrew install state 丢弃、网络/非法版本不覆写 cache、无 Homebrew command 和 native no-spawn 的 focused tests，加 update prompt/CLI documentation link 的就近断言；T3/T6 Green 后进入独立 `$[review-security]`。 |
| T4 | 只改现有 builtin body 与 registry test；不新增 skill 系统、主题或 loader。 | 八份 body 的 Tea 全局路径和允许的项目路径矩阵。 |
| T5 | 改现有 copy、migration target 和开发工具默认输入；不创建全局 copy helper。 | `export --help`、recovery command 与 conflict target 的就近断言。 |
| T6 | 不新增业务代码；改既有 workflow、Changesets 发布指引、Nix declaration 与 checker/list。 | `nix build .#tea-code` 后执行 `test -x result/bin/tea-code` 和 `nix run .#tea-code -- --version`，共同断言 derivation、app attr、wrapper、`mainProgram` 与 observed bin；再做 workflow owner/OIDC review、fork Changesets package/repository guidance 静态检查和 version dry run；T3/T6 Green 后进入独立 `$[review-security]`。 |
| T7 | 不新增生产代码；复用现有 test/build/lint/pack 工具完成聚合验收。 | 以 `tmp="$(mktemp -d)"` 建立临时目录，预置 upstream npm `kimi` 与 Python `kimi_cli` shim fixture，且仅把该 fixture（而非用户机器上的真实 shim）置于测试 PATH 前；运行 `npm --prefix apps/kimi-code pack --pack-destination "$tmp"`，将唯一 tarball 以 `npm install --global --prefix "$tmp/prefix" "$tmp"/*.tgz` 安装，断言两个 fixture 的路径和字节不变，并断言 `"$tmp/prefix/bin/tea-code" --version`；最后只删除该 `mktemp` 目录。重跑 T6 的 Nix 断言；按 residual inventory 的 M1--M8 清单逐项记录 `changed`、`retained:<A1--A5 + 理由>` 或 `out-of-scope:<理由>`，再运行其四条稳定交付集合 `rg` 命令；未映射的新命中阻断发布。 |

| ID | 任务 | 来源 | 范围 | 非目标与复杂度边界 | 前置依赖 | 验证方式 | Skill 路由 |
|---|---|---|---|---|---|---|---|
| T1 | 包元数据、npm 落地页、postinstall ownership、app smoke usage 与可复现 `+up` 版本编排 | G1, G5, D2, D3, G-rel-3, G-mig-2 | app/root `package.json`、`apps/kimi-code/README.md`、`.changeset/config.json`、两份 pending selector、`UPSTREAM_VERSION`、`scripts/version-release.mjs`、`apps/kimi-code/test/cli/version-release.test.ts` 与 `test/fixtures/version-release/{first-release,subsequent-release,old-selector,base-not-incremented}`、postinstall orchestrator/UI、`apps/kimi-code/test/postinstall/ownership.test.ts`、`apps/kimi-code/scripts/smoke.mjs`、root package filters | 不改内部 workspace 包名；不新增 version framework；测试 fixture 在临时根目录运行并清理；fork 不保留 legacy `kimi`/`kimi_cli` 的安装期检测或接管，任何既有 shim 均 no-op，不得改名或删除。 | 无 | Red：`pnpm -C apps/kimi-code exec vitest run test/cli/version-release.test.ts test/postinstall/ownership.test.ts`；version 覆盖首发、成功 subsequent release、old selector、base 未递增；ownership fixture 覆盖 upstream npm `kimi` 和 Python `kimi_cli`，断言 fork postinstall 后其路径和字节不变；T7 package-install fixture 再断言 `tea-code --version` 可用；再跑 app version/postinstall/smoke focused tests、`pnpm lint:pkg` 与 `npm --prefix apps/kimi-code pack --dry-run --json` 检查 CLI tarball。 | `$[tdd]`、`$[guard-policy]`、`$[gen-changesets]`（PR 前；major 必须另行确认）。 |
| T2 | Tea home 解析、单源身份常量与受控 env 传播 | G3, D5, G-mig-1 | 唯一 owner 为 app constants/paths（package/bin/home）；v1/v2/OAuth resolver；rg/MCP/session/profile fallback；plugin manager、official datasource、ACP、Inspector/vis default home | 不读旧 env、不迁移数据、不改项目 local config、OAuth key 或其余 env；不新增 home abstraction。 | 无 | 先补/改 `paths.test.ts`，直接断言 package/bin/home 常量；再跑 v1/v2 resolver、OAuth、plugin manager、ACP、Inspector discovery focused tests；默认与 explicit Tea home 都必须断言。 | `$[tdd]`、`$[guard-policy]`。 |
| T3 | npm registry 版本发现、cache/install-state provenance、fork 仓库链接与 fork-safe 更新来源 | G2, D4, D9, D10, G-fb-1, G-fb-2 | `cli/update/{cache,cdn,refresh,types,source,preflight,install-state,prompt}`、`cli/commands.ts` 与既有 update/CLI tests；只消费 T2 的 app constant；保留资源 consumer tests | 不自建 registry client/依赖、不改 marketplace/tips/fd URL、不保留 Homebrew 或 native 上游 installer 执行；registry cache 只接受 `npm-registry`/`manifest:null`，旧 CDN cache 与 Homebrew install state 丢弃而不迁移。 | T1, T2 | 先改 cache/cdn/refresh/preflight/install-state Red tests：registry refresh cache round-trip、旧 CDN cache/old Homebrew state 丢弃、异常不覆写、无 manifest、无 Homebrew command、native no-spawn、保留资源；为 update prompt 和 CLI documentation link 写就近断言；Green 后跑 update、cache/install-state、CLI link 与资源 focused suites，再进入 T3/T6 安全专项复核。 | `$[tdd]`、`$[guard-policy]`、`$[review-security]`（T3/T6 Green 后独立执行）。 |
| T4 | bundled skill 的 Tea 全局路径与项目路径保留矩阵 | G3, D5, D7 | 两 engine 的八份 builtin body、raw-loader/registry tests | 不改项目 `<root>/.kimi-code`、不新增 skill 系统或主题功能。 | T2 | 逐份 body 断言全局 Tea path/env，且仅允许 D7 项目路径；跑 v1 skill 与 v2 catalog focused tests。 | `$[tdd]`。 |
| T5 | 用户可见文案、migration target 与开发工具默认输入 | G1, G3, D5--D8 | TUI/CLI/Inspector 静态 copy、runtime recovery command、core config/proxy、migration-legacy、klient examples、minidb bench 与就近 tests；README、update/command link、Changesets 指引分别归 T1/T3/T6 | 不改 TUI 品牌、项目路径、历史 migration source、UA/telemetry、OAuth key；不创建全局 copy helper。 | T2 | 先写 `export --help`、auth/prompt、config、run-prompt/run-shell/provider/vis/web、migration target/stub、Inspector、klient/minidb的断言；通过后逐点改文案。 | `$[tdd]`、`$[write-tui]`。 |
| T6 | fork 发布 workflow、Changesets 指引与 Tea Nix 分发 | G1, G4, G5, D1, D11, G-rel-1--3 | `release.yml`、`pkg-pr-new.yml`、`.changeset/README.md`、Nix workspace checker/list/derivation、Nix attr/main program/install wrapper；release jobs | 只裁 docs/native jobs；不改 native SEA scripts，不更换 OIDC，不修改 docs site。 | T1 | `node scripts/check-nix-workspace.mjs`；`nix build .#tea-code`；`test -x result/bin/tea-code`；`nix run .#tea-code -- --version`；首发前执行 npm name/trusted-publisher gate（E404=available，collision/non-E404 error=stop）；release 后核对 workflow OIDC publish success 和 `npm view` version/dist.tarball；静态核对 Changesets 的 fork 包名/仓库/发布指引；release-version dry run；随后进入 T3/T6 安全专项复核。 | `$[guard-policy]`、`$[gen-changesets]`、`$[review-security]`（T3/T6 Green 后独立执行）。 |
| T7 | 端到端验收、pack/install 与八族残留对账 | G1--G5, D1--D11 | 全部上述变更的验证，不新增生产模块 | 不执行真实 publish、npm 帐户配置或 GHA；不修改 `third-party-projects/`、`enhancements/` 或 `.auto-runs/`；不把用户机器上的真实 PATH shim 作为 fixture。 | T3, T4, T5, T6 | 定向 suites → `pnpm build`、`pnpm typecheck`、`pnpm lint`、`pnpm test`、app smoke；以 `tmp="$(mktemp -d)"` 预置 `kimi` npm/Python shim fixture、仅以前置临时 fixture PATH 执行从 `apps/kimi-code` pack 的唯一 tarball 的隔离全局安装，断言 fixture 路径和字节不变并运行 `"$tmp/prefix/bin/tea-code" --version`，只删除该临时目录；重跑 Nix `tea-code` bin/app 断言；仅扫描 residual inventory 声明的稳定交付集合，逐项记录 M1--M8 与 A1--A5 处置；在干净与证据存在的 checkout 复跑结果一致。 | `$[tdd]`（验收回归）、`$[guard-policy]`。 |

## 风险、假设与回退

| ID | 触发条件 | 检测与回退 | 关联任务 |
|---|---|---|---|
| R1 | trusted publisher、scope 或包名不可用 | 首发前只接受 `npm view @futuretea/tea-code` 的 E404；已有 package、认证/网络错误或 trusted-publisher repository/workflow 不匹配均停止并记录证据。首次 GHA OIDC publish success 后，`npm view` 必须返回本次 version/dist.tarball；否则停止并修正账户配置或包名决定后重试。 | T6, T7 |
| R2 | registry 或内容资源不可达 | 单测失败路径；版本发现静默跳过，内容资源沿用既有失败行为，不回退到上游 installer。 | T3 |
| R3 | 仅 `+up` 后缀变化 | fixture 与 `version:release` dry run fail；不写版本、不发布。 | T1, T6 |
| R3a | fork postinstall 误把上游 `kimi` shim 认作 own | T1/T7 的隔离 npm `kimi` 与 Python `kimi_cli` fixture 断言路径/字节不变；失败时回退本地 ownership classifier 改动并修复，不改用户 PATH 或既有 shim。 | T1, T7 |
| R4 | identity sweep 命中未分类旧术语 | T7 仅扫描 residual inventory 的稳定交付集合，逐项对账；补 change 或 A1--A5 保留理由，不能以宽泛根目录 grep 通过。 | T2--T7 |
| R5 | Nix Tea attr/main program 或安装 bin 失败 | `nix build .#tea-code` 后执行 `test -x result/bin/tea-code` 与 `nix run .#tea-code -- --version`；回退本地 Nix 更改并修复 derivation/wrapper，不影响 npm package rollout。 | T6, T7 |
| R6 | 第三方插件依赖旧 env | official plugin tests；记录为已知限制，不新增 alias；如真实生态出现故障另开 enhancement。 | T2, T7 |

## 后续增强

- native SEA 发布与自托管上游内容资源。
- 项目级 `.kimi-code` 改名与迁移策略。
- UA/遥测 fork 化。
- migration-legacy 已迁移 marker 的提示适配。

## 质量自检

- [x] 单一当前切片；没有把后续能力写入 DAG。
- [x] 七个任务均有来源、边界、依赖、TDD 结论、验证与 Skill 标注。
- [x] 六项 Guard Policy 与四项外部环境依赖均有 plan 落点。
- [x] 八族残留清单已落盘并由 T7 对账。
- [x] 用户确认的 Nix Tea 分发决策已写入范围和 T6。
- [x] 不新增依赖、兼容 alias、公共 API 或未确认保护。
