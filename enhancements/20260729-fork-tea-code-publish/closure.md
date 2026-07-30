# Closure：fork 改名发布 @futuretea/tea-code

## 目标闭合（goal_closure）

status=closed。交付物（可发布的 `@futuretea/tea-code` npm 包 + 可用 GHA 发布流）、范围（`apps/kimi-code` 身份面 + 配置目录/环境变量 + 发布 workflow + 版本发现源）、约束（GHA OIDC、`futuretea` 分支、版本格式、干净切换、上游内容资源暂时保留）、成功标准与非目标均已在 `clarify.md` 固定。

## 可验证目标检查（measurable_goal_check）

status=closed。G1-G5 均为 `acceptance_signal`，每条具备 signal、通过条件、验证方法、证据来源（见 `clarify.md` 目标表），无无来源量化指标。G4（GHA 首次发布）的完整验证依赖仓库外动作，已映射到外部环境数据依赖 #1。

## 环境闭合（environment_closure）

status=closed。

- 上下文可用性：全部触点代码在仓库内可查（sidecar 已机械搜索盘点）。
- 可复现性：`pnpm build` / `npm pack` / smoke 本地可复现。
- 权限充足性：仓库写权限具备；npm `@futuretea` scope 权限用户已确认；GHA OIDC 不需要额外 secret。
- 客观反馈：build、vitest、smoke.mjs、npm registry 返回均为客观证据。
- 外部稳定性：npm registry 与 GHA OIDC 端点为稳定公共基础设施（advisory）。

## 影响面闭合（impact_surface）

本切片改变既有行为（包名、bin、配置目录、环境变量、发布流、更新检查源），适用影响面闭合。

**搜索规则**：关键字集 {`@moonshot-ai/kimi-code`、`KIMI_CODE_HOME`、`.kimi-code`、bin `kimi`、`KIMI_CODE_*`、版本/latest URL、内容资源 URL、UA/遥测标识} 的仓库宽口径搜索只用于提案期影响面发现（Research sidecar 报告：`.auto-runs/v2/auto-proposal/20260729-auto-proposal-fork-tea-code-publish/` 对应 task 输出 `agent-rkwc8bhu`），不构成实现或发布 scan scope。当前切片的实现/验收只使用 residual inventory 声明的稳定交付集合；`third-party-projects/`、docs、计划/运行产物和 native SEA scripts 均排除。6 项 needs-policy 已于 2026-07-29 经用户裁决（见 design-interview 后 6 条），当前无未裁决成员。

**命中清单与逐项分类**（行为影响项，表面引用项从略）：

| 命中 | 分类 | 说明 |
|------|------|------|
| `apps/kimi-code/package.json` name/bin/repository/homepage/bugs | in-scope | 改 `@futuretea/tea-code`、`tea-code`、fork URL |
| `apps/kimi-code/README.md`（`package.json` `files` 字段含之，随 npm 产物发布，是 fork 包的 npm 落地页；`:1,5,40,46` 含上游标题、badge、`install.sh` 与 `npm i -g @moonshot-ai/kimi-code` 指令） | in-scope | 最小改写身份与安装段落：标题、安装命令、仓库链接改指 fork，badge 移除或改指 fork；「不上 npm」理由对本成员不成立 |
| `apps/kimi-code/src/constant/app.ts`：`NPM_PACKAGE_NAME:38`、`KIMI_CODE_HOME_ENV:41`、`CLI_COMMAND_NAME:4`、`PROCESS_NAME:5`、`FEEDBACK_*:64,68` | in-scope | 单源常量，update/upgrade 链路自动跟随 |
| 版本发现：`constant/app.ts` 的 latest 元数据常量 + `src/cli/update/cdn.ts` | in-scope（用户裁决：改查 npm registry） | 仅替换 latest 元数据查询；基于 CDN 的灰度 rollout 元数据退化，版本发现不请求上游 CDN |
| 上游内容资源：CDN base、marketplace、tips、`fd` 资产、install.sh / install.ps1、官方安装页 | in-scope（保留，用户裁决） | 不删、不改指、不自托管；分别由插件、banner、`fd` 下载与安装 transport 消费，详见外部依赖 #4 |
| `src/cli/update/preflight.ts` brew / native 分支 | in-scope | fork 无 homebrew tap，移除 brew 提示；fork 无 native 发布物时 native 来源不执行上游脚本，提示 npm 安装（G-fb-2） |
| `src/cli/update/prompt.ts:17` CHANGELOG_URL、`src/cli/commands.ts:33` Documentation 链接 | in-scope | 改指 fork 仓库 |
| `KIMI_CODE_HOME` 直读点 9 处（`agent-core/src/config/path.ts:6`、`agent-core-v2/bootstrap.ts:148`、`oauth/toolkit.ts:457`、`oauth/oauth-manager.ts:154`、rgLocator×3、`vis/server/config.ts:6`、`kimi-inspect/serverDiscovery.ts:71`） | in-scope | 含绕过中心出口的重复实现，全部改 `TEA_CODE_HOME` |
| `~/.kimi-code` 直拼点 12 处（`oauth/toolkit.ts:459`、rgLocator×3、`vis/server/config.ts:10`、`kimi-inspect/serverDiscovery.ts:73`、`agent-core/session/index.ts:296`、`agent-core/profile/context.ts:80`、`agent-core-v2/agent/profile/context.ts:103`、`agent-core/skill/scanner.ts:71`、`agent-core/mcp/oauth/store.ts:35`、`plugins/official/kimi-datasource`） | in-scope | 全部改 `~/.tea-code`；`oauth/oauth-manager.ts:154` 经 round 2 review 复核无 `.kimi-code` 字面量（仅 env 直读），归上一行 |
| 插件子进程 env 注入：`agent-core/src/plugin/manager.ts:253,497`、`agent-core-v2/src/app/plugin/manager.ts:274,650`；插件侧读取 `plugins/official/kimi-datasource/bin/kimi-datasource.mjs:245` | in-scope | 插件生态外部契约，主进程与官方插件同步改 |
| `apps/kimi-code/src/cli/sub/acp.ts:32,57-66` ACP env 透传 | in-scope | ACP 客户端可见 env 名同步改 |
| builtin skill 文档 8 篇（agent-core / agent-core-v2 的 update-config、mcp-config、custom-theme、import-from-cc-codex） | in-scope | 随 bundle 发布、运行时指导模型操作真实目录；用户全局路径改 Tea，项目级 `.kimi-code` 按 D7 保留；逐份由 `proposal.md` 实现概览 10 的 skill catalog/registry 测试覆盖 |
| 用户可见 home 路径：TUI 登录/API key 提示、`tui.toml` 错误与默认模板、`export --help` | in-scope | 实际路径已由 home 解析决定；静态文案和新建模板同步改 `~/.tea-code`，避免引导错误路径；对应 `config`、`run-shell`、`export --help` 与 TUI identity-copy tests（proposal 实现概览 10） |
| 用户可见运行时命令与 config header：session/print 恢复（`run-prompt.ts:313,417`、`run-shell.ts:224`、`prompt-render.ts:387,396`、`v2/run-v2-print.ts:336`、`tui/kimi-tui.ts:782`、`tui/commands/session.ts:73`）、migration（`migration-screen.ts:291`）、provider/vis/web（`sub/provider.ts:359`、`sub/vis.ts:79,88`、`sub/web/deprecated-server.ts:20-28`、`sub/web/legacy-kill.ts:53,86`）、agent-core config（`config/toml.ts:50,91,189`）及代理 stderr（`utils/proxy.ts:289`） | in-scope | 用户复制的命令统一改 `tea-code`，默认 header 改 `~/.tea-code/config.toml`，代理前缀改 fork CLI；用 proposal 实现概览 10 指定的 CLI/TUI/core tests 覆盖。历史迁移对象 `kimi-cli` 按 D5、上游服务 key 按 D8、UA/telemetry 按 D6、项目级 `.kimi-code/` 按 D7 保留 |
| migration conflict notice 与 stub 检测针：`packages/migration-legacy/src/run-migration.ts`、`stub-detect.ts` | in-scope | notice 用 `input.target` 构造真实输出目录，不硬编码 home；stub 检测与默认 config/TUI 文本严格耦合并同步 Tea header。`integration.test.ts` 覆盖默认 Tea target 和显式 `TEA_CODE_HOME` target，`stub-detect.test.ts` / `steps/config.test.ts` 覆盖 byte-level 默认文本 |
| Kimi Inspect token placeholder：`apps/kimi-inspect/src/connection.tsx` | in-scope | 手动连接表单仅展示默认 token 路径，改为 `~/.tea-code`，不改发现或读取行为；`connection.test.tsx` 覆盖 placeholder |
| klient live examples 与 minidb bench 的 home 默认输入 | in-scope（开发工具子范围） | 直接读取 `homedir()/.kimi-code`，改默认 `~/.tea-code`；不顺带改文件名或“Kimi Code”语义；分别由既有 klient/minidb test 根的最小路径断言覆盖 |
| bin 名行为点：`scripts/smoke.mjs:63-69`、`flake.nix` 的公开 attr/`pname`/`mainProgram`/安装输出 | in-scope | smoke 断言与 Nix Tea 分发跟随；不修改 native SEA scripts。 |
| native SEA scripts：`apps/kimi-code/scripts/native/**`（含 `paths.mjs`） | out-of-scope（用户确认） | 当前切片不发布或改造 native SEA；T3 仅测试 update 不执行上游 native installer，T6/T7 仅验证 Nix Tea attr/bin/app。 |
| `postinstall`：orchestrator、`reach.mjs` marker、`migrate.mjs` legacy detector 与 UI | in-scope（fork no-op） | fork 安装不进入 legacy `kimi` / `kimi_cli` 探测或 takeover；不以双 package marker 识别并存安装，不改名、不删除已有 shim；保留 exit-0。隔离 upstream npm/Python shim fixture 断言路径和字节不变，tarball 预演断言 `tea-code --version`。 |
| release 流：`release.yml:6,14`、`pkg-pr-new.yml:18,40,50,53`、`.changeset/config.json:2`、`.changeset/README.md`、两份 pending `.changeset/*.md` selector、根 `package.json:21,24`、`scripts/check-nix-workspace.mjs:14`、`flake.nix:108-109` | in-scope | owner 守卫、触发分支、filter、changelog repo、nix 闭包根；首发把 app manifest 设为未发布 `0.0.0`，两份旧 selector 改 fork 包后由 minor 生成 `0.1.0`，release 编排脚本追加 `+up0.30.0` |
| native 发布链：`resolve-release.mjs:6,29-39`、`produce-manifest.mjs:25-29`、`package.mjs:17`、`_native-build.yml` 多处 | out-of-scope | 本切片不做 native 发布；release.yml 中 native jobs 裁掉，脚本留待后续增强 |
| `docs-deploy.yml`、`release.yml deploy-docs job` | in-scope（裁剪） | fork 不发布上游文档站，deploy-docs 裁掉 |
| `KIMI_CODE_*` 其余环境变量家族（~40 个） | out-of-scope（用户裁决） | 仅 `KIMI_CODE_HOME` 改 `TEA_CODE_HOME`，其余保持原名 |
| 项目级 `.kimi-code/` 目录（`mcp.json`、`local.toml`、`AGENTS.md`，6 处源码） | out-of-scope（用户裁决） | 存量项目兼容面大，本轮不改，列后续增强候选 |
| OAuth/平台持久化 key：`managed:kimi-code`、`oauth/kimi-code`、`kimi-code/<modelId>`、`KIMI_CODE_PLATFORM_ID` | out-of-scope | 持久化 key 与上游服务标识，改名破坏存量凭证（evidence_verified） |
| UA / 遥测：`CLI_USER_AGENT_PRODUCT:8`、`kap-server/telemetry.ts:25`、`apps/vscode/.../kimi-runtime.ts:63`、`telemetry/src/transport.ts:16` | out-of-scope（user_override） | CLI / kap-server 保留 `kimi-code-cli`，vscode 保留 `kimi-code-vscode`；遥测端点不改，风险已记录 |
| `packages/migration-legacy` marker、`apps/vscode` 迁移源 `~/.kimi` | out-of-scope | 历史幂等 marker；迁移源是旧 Python CLI；target_paths 导致的再提示行为见场景闭合第 6 条 |
| 内部 private 包名、docs/**、CHANGELOG、pnpm-lock | out-of-scope | 不上 npm / 文档站内容 / lock 由 pnpm 重生成；`apps/kimi-code/README.md` 不在此行，已单列 in-scope |

## 场景闭合（scenario_closure）

关键链路 × 七维度（仅写适用项，其余维度 `not-applicable`：无并发写入、无数据量拐点、无逆向业务流）：

1. **npm 全局安装 + postinstall**：异常——postinstall 永不失败（exit 0）是既有不变量，改名后必须保持；并发——fork 不探测或接管任何已有 `kimi` / `kimi_cli` shim。验证使用隔离临时 PATH 的 upstream npm/Python fixture，断言路径和字节不变，并在隔离 prefix 运行 `tea-code --version`；不得使用宿主机 PATH 作为 fixture。
2. **CLI 启动 → home 解析**：异常——`TEA_CODE_HOME` 指向不可写路径时的失败行为沿用既有实现，不新增兜底；边界——env 为空串视为未设置（沿用既有语义）。
3. **版本发现 / upgrade**：异常——npm registry 不可达时静默跳过（沿用既有失败行为）；下游影响——版本发现切换后提示文案/链接同步换；灰度 rollout 元数据退化且 update telemetry 保持既有字段结构；边界——仅 `+up` 后缀变化的版本会被 `semver.gt` 判为非更新，发布纪律（base 必须递增、append 脚本 fail）在该边界兜底。brew 来源移除；native 来源提示 npm 安装而不执行上游脚本。
4. **GHA 发布**：时序并行——rename PR 先把 app manifest 设为未发布 `0.0.0`、迁移两份 pending old-package selector 并固定 `UPSTREAM_VERSION=0.30.0`；changesets 再开 release PR，`version:release` 生成 `0.1.0+up0.30.0`，合并后发布；OIDC 失败 fail-closed 不产生半成品包；旧 selector 或 base 未递增时 release 编排失败；逆向——误发布用 `npm deprecate` / 72h 内 unpublish + revert commit。
5. **插件 env 注入**：下游影响——第三方插件若读 `KIMI_CODE_HOME` 会失效；官方插件同步改，第三方插件记录为已知限制（fork 生态初期无第三方插件）。
6. **migration-legacy 迁移提示（记录型，接受该行为）**：既有 marker 的 `target_paths` 指向 `~/.kimi-code`（`packages/migration-legacy/src/marker.ts:48-50`），干净切换后曾迁移旧 Python CLI 数据的存量用户安装 tea-code 会被再次提示迁移；提示可跳过、不读写 `~/.kimi-code`（G3 信号不受破坏）。处置：本切片接受该行为；fork 侧禁用或改指列入后续增强。
7. **上游内容资源（记录型，用户确认保留）**：marketplace、tips、`fd` 资产暂由上游控制。异常——资源不可达时沿用各自既有失败路径；边界——tips 的上游版本规则可能与 `+up` 格式不匹配，出现可复现问题后再单独裁决；不将资源保留包装为 fork 自托管或版本发现自指。
8. **运行时恢复指引**：异常——模型、config、migration、provider、vis、web 或 session 恢复路径报错时，用户看到的可复制命令必须是 `tea-code`，默认 config header 必须指向 `~/.tea-code`；migration conflict notice 必须显示调用方传入的实际 target。历史 `kimi-cli` 迁移对象和项目级 `.kimi-code/` 分别按 D5/D7 排除在替换之外。验证：`proposal.md` 实现概览 10 的五组测试逐项覆盖命令、home 文案、八份 bundled skill、migration target 和保留项。

持久化状态写入：本切片无新增持久化字段（仅路径与标识变化），状态持续期与周期结束行为 `not-applicable`。

## 外部环境数据依赖审查

| # | dependency | role | source | coverage | stability | failure_modes | behavior_on_failure | plan_mapping | classification |
|---|-----------|------|--------|----------|-----------|---------------|---------------------|--------------|----------------|
| 1 | npm `@futuretea` scope 权限与 trusted publisher 配置 | release_gate | npmjs.com 用户账户设置 | 用户已确认持有 scope；trusted publisher 配置动作待执行 | 用户控制，不漂移 | 未配置则 OIDC 发布失败 | blocked（fail-closed，不产生半成品） | 发布前置 checklist：核对 trusted publisher 指向 `futuretea/kimi-code` + release.yml | assumption（用户确认证据在，动作在仓库外） |
| 2 | `@futuretea/tea-code` 包名可用性 | release_gate | npm registry | 2026-07-29 `npm view` 返回 E404 | 首次发布后转为自有 | 被抢注则发布失败 | blocked | 发布前再次 `npm view` 核对 | evidence_verified |
| 3 | GHA + npm OIDC 公共基础设施 | release_gate | GitHub/npm 公共服务 | 不覆盖自建镜像场景 | 高 | 服务故障则发布延后 | blocked | 无（重试即可） | advisory |
| 4 | 上游内容资源：marketplace、tips、`fd` 资产与 native URL | runtime_input, evidence | `constant/app.ts` 资源常量与其消费者；`decision-record.md` | 默认 marketplace、tips、缺少系统 `fd` 的 TUI、native 来源均覆盖；不覆盖 fork 自托管资源 | 上游控制，随时可变 | 资源缺失、内容变化、tips 版本规则不匹配；native 误执行上游安装器 | 各资源沿用既有失败路径；native 来源本切片改提示 npm，不执行上游脚本 | 实现概览 2；测试计划 3/7；资源失效、tips 规则或自托管需求触发后续 enhancement | user_confirmed |

## Guard Policy Boundary

| guard_id | category | lifecycle_stage | active_consumers | consumer_note | failure_policy | guard_level | source | status |
|----------|----------|-----------------|------------------|---------------|----------------|-------------|--------|--------|
| G-rel-1 release.yml `repository_owner` 守卫（`MoonshotAI`→`futuretea`） | release | prelaunch（fork 未发布过） | no | fork 首发前由发布维护者触发 | fail-fast（owner 不匹配则 job 跳过） | block | user_confirmed | accepted |
| G-rel-2 `publishConfig.provenance` + OIDC trusted publishing（保留） | release | prelaunch | no | fork 首发前 npm registry 仅为发布目标 | fail-fast（OIDC 失败则发布失败） | block | user_confirmed | accepted |
| G-fb-1 版本发现源切换（上游 latest 元数据 → npm registry） | fallback | prelaunch | no | 首发后面向 tea-code 用户 | 版本发现源不可达时静默跳过（既有行为保留） | none（不阻断 CLI 使用） | user_confirmed | accepted |
| G-mig-1 配置目录切换 | migration | prelaunch（fork 无存量用户） | no | 同机上游用户保持互不影响 | fail-fast（无迁移代码，无可失败路径） | none（干净切换，用户裁决） | user_confirmed | accepted（guard 不适用） |
| G-rel-3 `version:release` 编排脚本 base 递增校验 | release | prelaunch | no | fork 发布维护者 | fail-fast（base 未递增或 pending old-package selector 则脚本/验证失败、不发布） | block | code_fact | accepted |
| G-fb-2 native 安装来源禁用上游安装器 | fallback | prelaunch | no | fork 无 native 发布物；首发后覆盖 native 检测 | warn（提示 npm 安装 fork 包） | none | user_confirmed | accepted |

## 闭合缺口（closure_gaps）

无。6 项 needs-policy 已于 2026-07-29 经用户裁决消除；fresh review 发现的用户可见路径、内容资源与 native 更新边界已按 `decision-record.md`、完整分类表与用户确认闭合。

## blocking_unknowns

无。

## assumptions

- 内部 private 包名不改：tsdown `onlyBundle:false` 整体打包，npm 产物不含内部包名引用（`apps/kimi-code/tsdown.config.ts:34`）。影响范围：发布产物；回退：改 bundle 配置。
- brew 升级提示分支砍掉：fork 无 homebrew tap（`preflight.ts:82,128`）。影响范围：upgrade 文案；回退：恢复分支。
- deploy-docs job 与 native jobs 从 fork 的 release.yml 裁掉：fork 不发布文档站与 native 二进制。影响范围：workflow；回退：恢复 job。
- 版本检查改 npm registry 后灰度 rollout 元数据退化：原 CDN latest.json 携带的灰度信息在 npm registry 方案下不可用，退化为 latest 比较。影响范围：更新提示时机；回退：自建版本源。
- UA/遥测保留的风险：fork 使用数据打进上游遥测后端、UA 身份不透明（user_override，用户已知悉）。影响范围：上游统计口径；回退：后续增强改 UA/关遥测。
- 上游 tips 的版本规则可能不匹配 `0.1.0+up0.30.0`：tips 用当前版本匹配上游范围，不承诺其将 fork build metadata 解释为上游基线。影响范围：banner 展示；回退：出现可复现问题后单独评估使用上游基线或禁用/自托管 tips。

## advisories

- pnpm-lock.yaml 在改包名后需 `pnpm install` 重生成。
- docs/**、sync-changelog skill 等表面引用可批量延后（`apps/kimi-code/README.md` 已转入 in-scope，见影响面表）。
- vscode 扩展品牌（`kimi-code` / `moonshot-ai` publisher）是独立决策，本轮不动。
- 项目级 `.kimi-code/` 目录改名列为后续增强候选。
- marketplace、tips、`fd` 资产与 native 分发由上游控制；本切片的保留不构成自托管承诺。

## readiness_verdict

pending independent re-review——blocking_unknowns 为空，目标/环境/影响面/外部依赖/Guard Policy 已闭合；fresh review 的 P1 修复已落盘，尚未获得最终独立全量通过证据。
