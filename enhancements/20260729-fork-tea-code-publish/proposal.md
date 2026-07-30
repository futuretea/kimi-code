# fork 改名发布 @futuretea/tea-code

## 产物状态

| 字段 | 值 |
|------|----|
| 产物状态 | `delivered` |
| 计划准备度 | `pass` |
| 最新审查证据 | `.auto-runs/v2/auto-proposal/20260729-auto-proposal-fork-tea-code-publish-r3/review-report-round-7.md` |
| 阻塞项 | `none` |
| 创建日期 | 2026-07-29 |

## 摘要

`futuretea/kimi-code` 是 `MoonshotAI/kimi-code` 的 fork，需要以独立身份发布自己的 npm 包。本切片把 `apps/kimi-code` 的身份面（包名 `@futuretea/tea-code`、bin `tea-code`、配置目录 `~/.tea-code`、环境变量 `TEA_CODE_HOME`、更新检查源、GHA 发布流）整体切换，使用户可以 `npm i -g @futuretea/tea-code` 安装并以 `tea-code` 运行，与上游并存安装互不干扰。用户已裁决的保留面（OAuth/平台持久化 key、User-Agent、遥测端点、其余 `KIMI_CODE_*` 环境变量、项目级 `.kimi-code/` 目录）不动。

---

## 动机

### 目标

1. **G1 可发布可安装**：`npm i -g @futuretea/tea-code` 成功后 `tea-code --version` 输出含 `0.1.0+up0.30.0`，TUI 可启动。验证：首次 GHA 发布后真实全局安装；发布前 `pnpm build` + `npm pack` + 本地安装预演。证据：命令输出、npm registry。
2. **G2 版本发现源自指**：更新检查的版本发现（含 `upgrade` 的查询步骤）查询 npm registry 的 `@futuretea/tea-code`，不再请求上游 CDN 的版本元数据、不再使用上游包名。marketplace、tips、`fd` 下载与安装 transport 是明确保留的上游内容资源，不属于本目标。验证：代码检查 + 单测/运行时干跑。证据：源码与测试。
3. **G3 配置目录切换**：干净 HOME 下启动后读写 `~/.tea-code`；`TEA_CODE_HOME` 优先生效；不再创建/读写 `~/.kimi-code`。验证：临时 HOME 启动观察。证据：命令输出。
4. **G4 GHA 发布流可用**：push 到 `futuretea` 触发 release.yml，owner 守卫通过，OIDC 发布成功。验证：首次真实发布 run + `npm view`。证据：GHA 日志、npm registry。
5. **G5 版本格式可持续**：package.json version 为 `0.1.0+up0.30.0`，后续 changeset 版本流自动维持 `+up` 后缀；每次发布 base 版本必须递增——仅 `+up` 变化时 append 脚本 fail，防止 `semver.gt` 把新版本判为非更新。验证：`version:release` 干跑（含 base 未递增用例）。证据：package.json、脚本输出。

### 非目标

1. 不改 20 个内部 private workspace 包名（tsdown 整体 bundle，不进 npm 产物）。
2. 不改上游服务契约：`managed:kimi-code` / `oauth/kimi-code` / `kimi-code/<modelId>` 持久化 key、`X-Msh-Platform`、OAuth clientId（改名会破坏存量用户配置与凭证，evidence_verified）。
3. 不改 User-Agent（CLI / kap-server 为 `kimi-code-cli`，vscode 为 `kimi-code-vscode`）与遥测端点（user_override 保留，风险已记录）。
4. 不改项目级 `.kimi-code/` 目录与 `KIMI_CODE_*` 其余环境变量；仅 `KIMI_CODE_HOME` 改 `TEA_CODE_HOME`。
5. 不迁移 `~/.kimi-code` 数据、不读取旧 `KIMI_CODE_HOME`（干净切换，重新 login）。
6. 不改 TUI 品牌文案、`apps/kimi-code` 目录名、vscode 扩展品牌。
7. 不做 native SEA 发布流；release.yml 的 native 与 deploy-docs jobs 裁掉。fork 未拥有 native 发布物时，检测到 native 安装来源不执行上游脚本，改提示 npm 安装 fork 包。
8. 不动 docs/ 内容、插件 marketplace 内容、tips 内容、`fd` 上游资产、git remote / 分支结构 / commit 历史；这些上游资源暂时保留为外部依赖。

### 当前切片

- **本轮交付**：以 `@futuretea/tea-code@0.1.0+up0.30.0` 完成身份面切换并通过 GHA OIDC 首次发布。
- **验收信号**：G1-G5 全部达成；`tea-code` 与上游 `kimi` 同机并存且配置互不干扰。
- **是否需要新增代码**：yes。新增量集中在版本发现切换（npm registry 查询替代上游 latest 元数据）、native 来源禁用上游安装器与 `version:release` 的 `+up` 后缀拼接；其余为机械改名。
- **现成能力检查**：home 解析沿用三处中心出口（`agent-core/src/config/path.ts:5`、`agent-core-v2/src/app/bootstrap/bootstrap.ts:143`、`constant/app.ts` → `paths.ts`），只改默认值与 env 名，不新增解析层；npm registry 查询复用 Node 内置 `fetch`（update 链路已有网络请求模式，见 `src/cli/update/cdn.ts`），不新增依赖。
- **不得混入**：native 发布链适配或自托管、项目级 `.kimi-code/` 目录改名、UA/遥测变更、docs 内容改写、vscode 扩展品牌。
- **升级触发条件**：none。

### 后续增强

- native SEA 发布链的 fork 适配（4 处联动硬编码 + Apple 签名 secrets）。
- 项目级 `.kimi-code/` 目录改名（涉及存量项目兼容，需独立评估）。
- UA / 遥测端点的 fork 化（用户本轮裁决保留，未来可重议）。
- 上游文档站内容 fork 化。
- migration-legacy 迁移提示适配：旧 marker 的 `target_paths` 指向 `~/.kimi-code`，干净切换后曾迁移旧 Python CLI 数据的存量用户会被再次提示（可跳过、不读写 `~/.kimi-code`）；fork 侧禁用或改指列入后续增强。
- marketplace、tips、`fd` 资产与 native 分发的 fork 自托管；出现可复现的资源失效或 tips 版本规则不匹配时单独裁决。

---

## 提案

### 用户故事

**故事 1：fork 用户全新安装**
- **改造前**：fork 没有自己的 npm 包，用户只能从源码 `pnpm dev` 跑，或装上游 `@moonshot-ai/kimi-code` 得到上游身份。
- **原因**：fork 需要独立分发身份，且不能与上游共享配置目录（同机并存会互相污染登录态与配置）。
- **改造后**：`npm i -g @futuretea/tea-code` 后直接用 `tea-code`，配置落在 `~/.tea-code`，与上游 `kimi` 并存互不干扰；首次使用重新 login。

**故事 2：fork 维护者发版**
- **改造前**：release.yml 被 `repository_owner == 'MoonshotAI'` 守卫拦住，fork 无法发布；changesets 配置指向上游。
- **原因**：fork 需要自己的发布流水线，且要保留 OIDC provenance。
- **改造后**：push `futuretea` 分支即触发 changesets 发布流，OIDC trusted publisher 直发 npm，版本号自动携带 `+up<上游版本>` 后缀标明上游基线。

**故事 3：fork 用户收到更新提示**
- **改造前**：更新检查打上游 CDN，会拿上游版本号引导用户 `npm i -g @futuretea/tea-code@<不存在的版本>`。
- **原因**：fork 不拥有上游 CDN，版本源必须自指。
- **改造后**：更新检查查询 npm registry 的 `@futuretea/tea-code` latest，提示与安装命令都指向 fork 包。

### 详细用户体验

```bash
npm install -g @futuretea/tea-code   # 安装 fork 包
tea-code --version                   # 输出含 0.1.0+up0.30.0
tea-code                             # 启动 TUI；配置写入 ~/.tea-code
TEA_CODE_HOME=/tmp/tc tea-code       # 环境变量优先生效
```

发布侧（维护者）：

```bash
git push origin futuretea            # 触发 release.yml
# changesets 开 release PR → 合并后 OIDC 发布
npm view @futuretea/tea-code         # 可见 0.1.0+up0.30.0
```

### API 变更

| 资源 | 变更类型 | 字段/行为 | 说明 |
|------|----------|-----------|------|
| npm 包 | 改名 | `@moonshot-ai/kimi-code` → `@futuretea/tea-code` | 全新包，无存量消费者 |
| CLI bin | 改名 | `kimi` → `tea-code` | fork postinstall 不探测、接管或改写既有 `kimi` / `kimi_cli` shim；上游与 fork 以不同 bin 并存 |
| 配置目录 | 改名 | `~/.kimi-code` → `~/.tea-code` | 干净切换，无迁移 |
| 环境变量 | 改名 | `KIMI_CODE_HOME` → `TEA_CODE_HOME` | 仅此一个；含插件子进程注入与 ACP 透传 |
| 版本发现 | 行为变更 | 上游 CDN latest.json → npm registry latest | 灰度 rollout 元数据退化；安装 transport 与上游内容资源不属于此变更 |
| native 更新 | 行为变更 | native 来源不执行上游 install.sh / install.ps1 | fork 没有 native 发布物时提示 npm 安装；自托管另立 enhancement |
| 发布 workflow | 行为变更 | 触发分支 `futuretea`、owner 守卫 `futuretea`、裁 native/docs jobs | 保留 OIDC provenance |

---

## 进入计划准备度

fresh review 的 P1 修复已开始；在下一份 independent full-scope review 返回 `plan_ready=pass` 前，不得进入 plan。

### 开放问题与假设

| ID | 类型 | 问题 / 假设 | 证据 / 回退方式 | 影响章节 |
|----|------|-------------|----------------|----------|
| A1 | assumption | trusted publisher 配置动作待用户在 npmjs.com 执行 | 用户已确认持 `@futuretea` scope；OIDC 失败 fail-closed 不产生半成品；发布前置 checklist 核对 | 设计细节 / 升级策略 |
| A2 | assumption | 内部 private 包名不改不影响产物 | `tsdown.config.ts:34` `onlyBundle:false` 整体打包；回退：改 bundle 配置 | 非目标 |
| A3 | assumption | brew 升级提示分支砍掉 | fork 无 homebrew tap（`preflight.ts:82,128`）；回退：恢复分支 | 实现概览 |
| A4 | assumption | 灰度 rollout 元数据随版本发现切换退化 | 原 latest.json 灰度字段在 npm registry 方案下不可用；回退：自建版本源 | 实现概览 |
| A5 | assumption | UA/遥测保留的风险 | fork 遥测打进上游后端、UA 身份不透明；user_override 已知悉；回退：后续增强改 UA/关遥测 | 非目标 |
| A6 | assumption | 上游 tips 的版本筛选可能无法把 fork 的 `0.1.0+up0.30.0` 等同上游 `0.30.0` | tips 直接用当前版本匹配上游范围；出现 `banner_min_version`、`banner_max_version` 或精确版本规则且造成可复现问题时，另开 enhancement | 保留面 / 后续增强 |

### 决策记录

`discussion_required=true`。fresh review 暴露了版本发现与非版本 CDN 资源、native 更新的竞争路径；独立 Tier A 多视角讨论和两项用户确认已固定在 `decision-record.md`。该记录的结论是：版本发现只切 npm registry；上游内容资源暂时保留；native 来源禁用上游安装器。

| ID | 决策 | 原因 | 来源 |
|----|------|------|------|
| D1 | GHA OIDC trusted publisher 发布，`futuretea` 分支 | 用户确认；release.yml 已有 OIDC 骨架 | user_confirmed |
| D2 | 身份面：`@futuretea/tea-code` + tea-code 三件套 | 用户确认（包名为 user_override 改口） | user_confirmed / user_override |
| D3 | 版本格式 `0.1.0+up0.30.0`；发布纪律：每次发布 base 版本必须递增 | 用户确认格式；semver 比较忽略 build metadata——`+up` 变化本身不构成更新信号，因此 `UPSTREAM_VERSION` 变更必须伴随 changeset，append 脚本在 base 未递增时 fail | user_confirmed |
| D4 | 版本发现改查 npm registry | 用户确认；上游 CDN 不归 fork 所有 | user_confirmed |
| D5 | 配置目录干净切换 | 用户确认；并存安装互不污染 | user_confirmed |
| D6 | UA 与遥测端点全部保留 | 用户 override（推荐是改 UA + 关遥测），风险已记录 | user_override |
| D7 | 项目级 `.kimi-code/` 目录与其余 `KIMI_CODE_*` env 不改 | 用户确认；存量项目兼容与上游服务开关语义 | user_confirmed |
| D8 | 上游服务持久化 key 保留 | `managed:kimi-code` 等持久化在用户配置与凭证中，改名即失配 | evidence_verified |
| D9 | marketplace、tips、`fd` 资产与 native URL 暂时保留上游来源 | 用户确认；它们不是版本发现，且删除会误伤现有内容或工具路径 | user_confirmed |
| D10 | native 来源不执行上游安装脚本，提示 npm 安装 fork | 用户确认；fork 没有 native 发布物，避免 fork 版本发现转回上游安装器 | user_confirmed |

### 保护策略

| guard_id | category | lifecycle_stage | active_consumers | consumer_note | trust_boundary | contract_surface | failure_policy | guard_level | source | status |
|----------|----------|-----------------|------------------|---------------|----------------|------------------|----------------|-------------|--------|--------|
| G-rel-1 | release | prelaunch | no | fork 首发前由发布维护者触发 | GHA workflow | release.yml owner 守卫（`MoonshotAI`→`futuretea`） | fail-fast（owner 不匹配则 job 跳过） | block | user_confirmed | accepted |
| G-rel-2 | release | prelaunch | no | fork 首发前 npm registry 仅为发布目标 | GHA ↔ npm OIDC | `publishConfig.provenance` + trusted publisher（保留） | fail-fast（OIDC 失败则发布失败） | block | user_confirmed | accepted |
| G-fb-1 | fallback | prelaunch | no | 首发后面向 tea-code 用户 | CLI ↔ 版本发现源 | 版本发现切换（上游 latest 元数据→npm registry） | 版本发现源不可达时静默跳过（既有行为保留） | none | user_confirmed | accepted |
| G-mig-1 | migration | prelaunch | no | 同机上游用户保持互不影响 | CLI ↔ 用户家目录 | 配置目录干净切换 | fail-fast（无迁移代码，无可失败路径） | none | user_confirmed | accepted（guard 不适用） |
| G-rel-3 | release | prelaunch | no | fork 发布维护者 | `version:release` 脚本 | 版本格式约定（base 递增） | fail-fast（base 未递增则脚本失败、不发布） | block | code_fact | accepted |
| G-fb-2 | fallback | prelaunch | no | fork 无 native 发布物；首发后覆盖 native 检测 | native 安装来源 ↔ 安装 transport | native 来源不执行上游安装脚本 | warn（提示 npm 安装 fork 包） | none | user_confirmed | accepted |

---

## 设计细节

### 架构

```
身份面（本切片改）                          保留面（用户裁决不动）
┌─────────────────────────────────────┐    ┌──────────────────────────────────┐
│ package.json: name/bin/version/urls │    │ OAuth/平台持久化 key              │
│ README.md（npm 落地页）              │    │ UA（CLI/kap-server/vscode）       │
│ constant/app.ts 单源常量             │    │ 遥测端点                          │
│ home 解析：3 中心出口 + 12 直拼点     │    │ KIMI_CODE_* 其余 env              │
│ 插件 env 契约 + ACP 透传 + 官方插件   │    │ 项目级 .kimi-code/ 目录           │
│ builtin skill 文档 ×8                │    │ postinstall legacy takeover        │
│ 更新检查：cdn.ts → npm registry      │    │ （fork 不进入该路径）              │
│ 发布流：release.yml / changesets     │    │                                  │
└─────────────────────────────────────┘    └──────────────────────────────────┘
```

### 实现概览

1. **单源常量先行**：`constant/app.ts` 是包名、env 名、CLI 名的单源（`NPM_PACKAGE_NAME:38`、`KIMI_CODE_HOME_ENV:41`、`CLI_COMMAND_NAME:4`、`PROCESS_NAME:5`），先改这里让全链路自动跟随，再处理 12 处目录直拼点与 9 处 env 直读点（sidecar 已逐点定位，见 `closure.md` 影响面表）。同步最小改写 `apps/kimi-code/README.md`（`files` 字段含之，是 npm 落地页）：标题、安装命令与仓库链接改指 fork，badge 移除或改指 fork。
2. **版本发现与安装 transport 拆分**：版本发现改为 npm registry 的 `@futuretea/tea-code` latest（Node 内置 `fetch`，不新增依赖），只替换上游 `/latest` 与 `/latest.json` 元数据常量和请求；registry 无 manifest 时退化为 latest 直比（A4），但保留 update telemetry 的既有字段结构。共享的上游内容资源常量不得删除：marketplace、tips、`fd` 下载与 native URL 仍指向上游并在 closure 中逐项登记。brew 来源因 fork 无 tap 移除；native 来源不执行上游脚本，改显示 npm 安装 fork 包（D10、G-fb-2）。`prompt.ts:17` 与 `commands.ts:33` 链接改指 fork 仓库。
3. **首发与后续的 `+up` 版本编排**：把根 `version:release` 改为单一 `scripts/version-release.mjs`，由它记录变更前的 fork package base、执行 `changeset version`、校验结果 base 以 semver 严格递增，再读取 tracked 文件 `apps/kimi-code/UPSTREAM_VERSION` 追加 `+up<内容>`。首发 rename PR 的确定输入是：`apps/kimi-code/package.json` 同时改名并设未发布基线 `0.0.0`；`UPSTREAM_VERSION` 写 `0.30.0`；将仅有的两份 pending selector（`.changeset/v1-custom-agent-files.md`、`.changeset/v1-secondary-model.md`）从 `@moonshot-ai/kimi-code` 改为 `@futuretea/tea-code`，保留其 minor 和说明；`.changeset/README.md` 的发布说明同步改指 fork。Changesets 因此把 `0.0.0` + minor 提升为 `0.1.0`，编排脚本产出首次目标 `0.1.0+up0.30.0`。后续 release 从已发布的 `base+up` 版本先得到更高 base 再追加当期上游基线。fixture 必须从这组输入复现首发结果；任何 pending `.changeset/*.md` 仍选择旧包名，或 base 未递增（仅 `UPSTREAM_VERSION` 变化），脚本/验证均 fail，不发布。semver 比较忽略 build metadata，仅 `+up` 变化会被 `semver.gt`（`src/cli/update/select.ts:11`）判为非更新，因此不能静默发布（D3）。
4. **发布流改造**：`release.yml` 触发分支与 owner 守卫改 `futuretea`，裁掉 `deploy-docs`、`native-artifacts`、`publish-native-assets` 三个 job；`.changeset/config.json` 的 repo 与 baseBranch 改 fork；`.changeset/README.md` 的发布包名、示例和 trusted-publisher 指引改指 fork；`pkg-pr-new.yml` owner 与 `--filter` 跟随；根 `package.json` / `scripts/check-nix-workspace.mjs:14` / `flake.nix` 的包名引用跟随。Nix 仅改公开 Tea attr、`pname`、`mainProgram` 和安装输出；native SEA scripts（含 `apps/kimi-code/scripts/native/paths.mjs`）保持非目标（flake.nix 全手工维护，漏改会断 nix build）。
5. **postinstall 精确处理**：fork postinstall 保持 exit-0，但不进入 legacy `kimi` / `kimi_cli` 探测或 takeover；不以双 package marker 识别并存安装，不改名、不删除任何已有 shim。用隔离 upstream npm `kimi` 与 Python `kimi_cli` fixture 证明路径和字节不变；tarball 安装预演另断言 `tea-code --version` 可用。
6. **复杂度边界**：不新增依赖、不新增公共 API、不新增配置项；home 解析不新增抽象层；不引入迁移代码（D5）。
7. **保护策略映射**：G-rel-1/G-rel-2 → release gate（首次发布前 checklist：trusted publisher 指向、`npm view` 包名核对）；G-rel-3 → 测试（测试计划 5 的 first-release、后续 release、base 未递增用例）+ release gate（发布前 `version:release` 干跑）；G-fb-1 → 测试（registry 不可达时静默跳过的用例）+ manual verification；G-fb-2 → native 来源测试（只提示 npm，不执行上游脚本）；G-mig-1 → 测试（干净 HOME 下不触碰 `~/.kimi-code`）。
8. **影响面封闭规则**：身份面以已核实样例（`constant/app.ts`、`release.yml`、`agent-core/src/config/path.ts`、`plugins/official/kimi-datasource`、`apps/kimi-code/README.md`）作为实现定位起点；发布前扫描严格使用 residual inventory 的四条稳定交付命令，并逐项按 M1--M8 与 A1--A5 对账。该集合排除 `enhancements/`、`.auto-runs/`、`third-party-projects/`、docs、未列出的 native SEA scripts（含 `apps/kimi-code/scripts/native/paths.mjs`）和其他非交付证据；不得以仓库全量 grep 扩大当前切片或改变 release gate 结果。
9. **运行时命令与路径文案**：bin sweep 的运行时子集必须逐项改为 fork 身份，不让实现者只依赖 `CLI_COMMAND_NAME` 的间接传播。更新 session/print 恢复命令（`run-prompt.ts:313,417`、`run-shell.ts:224`、`prompt-render.ts:387,396`、`v2/run-v2-print.ts:336`、`tui/kimi-tui.ts:782`、`tui/commands/session.ts:73`）、migration 提示（`migration-screen.ts:291`）、provider/vis/web 错误和 help（`sub/provider.ts:359`、`sub/vis.ts:79,88`、`sub/web/deprecated-server.ts:20-28`、`sub/web/legacy-kill.ts:53,86`）、agent-core 的默认 config header 与 `doctor` 恢复提示（`config/toml.ts:50,91,189`），以及 stderr 的代理诊断前缀（`utils/proxy.ts:289`）。保留的上游服务 key、User-Agent、telemetry、项目级 `.kimi-code/` 和仅为历史对象命名的 `kimi-cli` 文案不在此组；每个保留项按 closure 的排除理由复核。
10. **运行时身份面逐组闭合**：以下表是 closure 影响面表第 42--47 行的唯一实现与测试映射。每组均先按 `TEA_CODE_HOME` / 默认 `~/.tea-code` 生成用户全局路径；只有表中明确标记的历史或项目契约可以保留 `kimi-cli`、`KIMI_CODE_*`、上游服务标识或项目级 `.kimi-code/`。

| 组 | 改动的源成员 | 明确保留 | 落地测试 |
|----|--------------|----------|----------|
| bundled skills | `packages/agent-core/src/skill/builtin/{update-config,mcp-config,custom-theme,import-from-cc-codex}.md` 与 `packages/agent-core-v2/src/app/skillCatalog/builtin/{update-config,mcp-config,custom-theme,import-from-cc-codex}.md`：全部用户全局目录、环境变量和示例改为 Tea 身份 | 每篇中的项目级 `<project root>/.kimi-code` 与 `<cwd>/.kimi-code/mcp.json` 保留（D7，项目契约） | 扩展 `packages/agent-core/test/skill/{registry,builtin-update-config,builtin-custom-theme}.test.ts` 及 `packages/agent-core-v2/test/app/skillCatalog/registry.test.ts`：逐一读取八份实际 bundled 内容，断言全局 Tea 路径/环境变量，且仅允许项目级 `.kimi-code` 留存 |
| TUI、CLI 与 Inspector 的静态 home 文案 | `apps/kimi-code/src/tui/commands/{auth,prompts}.ts` 的 API-key 保存提示、`tui/config.ts` 的错误和默认模板、`cli/sub/export.ts` 的 help，以及 `apps/kimi-inspect/src/connection.tsx` 的 token placeholder 都改为 Tea home | 无；这些都是默认用户全局目录提示 | 扩展 `apps/kimi-code/test/tui/config.test.ts`、`apps/kimi-code/test/cli/{run-shell,provider,export}.test.ts`；`export.test.ts` 渲染 export command help/option description，断言 `~/.tea-code/logs/kimi-code.log` 且不含旧用户全局 home；新增一个就近的 `apps/kimi-code/test/tui/commands/identity-copy.test.ts` 覆盖 auth/prompt 两种 API-key subtitle；新增 `apps/kimi-inspect/src/connection.test.tsx` 覆盖 placeholder |
| migration-legacy 的实际 target 与 stub | `packages/migration-legacy/src/run-migration.ts` 的两个 conflict notice 用 `input.target` 与 sibling 文件名拼接，不硬编码 home；`stub-detect.ts` 的 config/TUI 默认文本同步 Tea header | migration source、marker 与文件后缀 `kimi-cli` 保留（D5 的干净 target 切换；source/marker 是历史对象的既有代码事实，不是 target 身份） | 扩展 `packages/migration-legacy/test/integration.test.ts`：分别以默认 Tea target 与显式 `TEA_CODE_HOME` target 触发 config/TUI conflict，断言 notice 精确引用实际 target；扩展 `stub-detect.test.ts` 和 `steps/config.test.ts` 断言 Tea 默认 stub 的 byte-level 匹配 |
| 可复制命令、config header 与代理诊断 | 本条第 9 项列出的 `apps/kimi-code` runtime 字符串、`packages/agent-core/src/config/toml.ts`、`apps/kimi-code/src/utils/proxy.ts` 全部输出 `tea-code` 和 Tea header | `kimi-cli` 迁移源按 D5 保留；项目级 `.kimi-code/` 按 D7 保留；UA/telemetry 按 D6 保留；OAuth/平台 key 按 D8 保留 | 扩展 `apps/kimi-code/test/cli/{run-prompt,run-shell,provider,vis}.test.ts`、`test/migration/migration-screen.test.ts`、相关 web/TUI session tests，与 `packages/agent-core/test/config/configs.test.ts` / `test/rpc/config-rpc.test.ts`；断言输出不含旧默认命令或 home |
| 开发工具默认输入 | `packages/klient/examples/*` 与 `packages/minidb/bench/*` 的用户全局默认输入改为 Tea home | 文件名、示例中的“Kimi Code”服务语义不改 | 为每个包的现有 test 根新增最小路径断言（`packages/klient/test/contract.test.ts`、`packages/minidb/test/db.test.ts`），只检查其默认输入不再指向 `~/.kimi-code` |

### 测试计划

1. `pnpm build` + `pnpm typecheck` + `pnpm lint` 全绿。
   - 预期结果：改名后全仓库构建通过。
   - 最小可运行检查：`apps/kimi-code/scripts/smoke.mjs`（断言已跟随 bin 改名）。
2. home 解析单测：临时 HOME 启动，断言写入 `~/.tea-code`、`TEA_CODE_HOME` 优先、不触碰 `~/.kimi-code`。
   - 预期结果：三条断言成立（G3）。
   - 最小可运行检查：agent-core / agent-core-v2 / oauth 的既有 home 解析测试更新后通过。
3. 版本发现单测：mock npm registry 返回更高版本 → 提示升级且 npm 安装命令为 `npm i -g @futuretea/tea-code@<版本>`；registry 不可达 → 静默跳过；非 2xx、空或非法 `version` 不覆盖缓存。验证版本发现不请求上游 latest URL，registry 场景保持无 manifest 的 telemetry 字段语义。
   - 预期结果：版本发现路径正确（G2、G-fb-1），不误改 marketplace、tips、`fd` URL。
   - 最小可运行检查：update 链路既有测试改造。
4. `npm pack` + 本地全局安装预演：`tea-code --version` 输出 `0.1.0+up0.30.0`，TUI 可启动（G1 发布前预演）。
   - 预期结果：产物自包含、bin shim 名正确、产物内 README 身份为 fork（标题/安装命令/链接）。
   - 最小可运行检查：not-applicable（安装流程为 npm 平台行为）。
5. `version:release` 干跑：fixture A 从 `@futuretea/tea-code@0.0.0`、`UPSTREAM_VERSION=0.30.0` 和两份已迁移的 minor changeset 开始，断言输出精确为 `0.1.0+up0.30.0`；fixture B 从已发布 `0.1.0+up0.30.0` 加一个 fork minor changeset，断言先得到 `0.2.0` 再追加当期后缀；fixture C 仅变 `UPSTREAM_VERSION`，断言 base 未递增时脚本 fail 且不写版本；fixture D 留一份旧包名 selector，断言验证 fail（G1、G5、D3）。
   - 预期结果：首发输入、后续 release、旧 selector 和 up-only 场景均可复算。
   - 最小可运行检查：`scripts/version-release.mjs` 对 fixture package/changeset 输入输出断言。
6. 并存安装：在隔离临时 PATH 中预置 upstream npm `kimi` 与 Python `kimi_cli` shim，再安装 fork tarball。
   - 预期结果：postinstall exit 0，两个 fixture 的路径和字节不变，`tea-code --version` 可用；不使用宿主机真实 PATH 作为 fixture。
   - 最小可运行检查：新增 postinstall ownership 回归与 package-scoped pack/install 预演。
7. native 来源回归：模拟 native 安装来源时不得执行上游 `install.sh` / `install.ps1`，输出 npm 安装 fork 包的指引；marketplace、tips、`fd` 下载默认 URL 保持上游值。
   - 预期结果：G-fb-2 成立，保留资源不被版本发现改动误伤。
   - 最小可运行检查：update preflight 与内容资源既有测试更新。
8. 运行时身份文案回归：按实现概览第 10 项的五组测试逐项执行，不能以一次全局替换或间接常量传播代替。覆盖八份 bundled skill、TUI/API-key/config/export/Inspector 的静态 home 提示（含 `apps/kimi-code/test/cli/export.test.ts` 对 `export --help` 的默认全局 log 路径断言）、migration-legacy conflict notice 与 stub、可复制命令/config header/代理诊断，以及开发工具默认输入；同一 sweep 命中的 `kimi-cli` 历史迁移、项目级 `.kimi-code/` 和用户确认的服务契约保持原样。
   - 预期结果：fork-only 安装的每条用户可见恢复路径均可直接复制执行；默认或显式 `TEA_CODE_HOME` target 都不会显示 `~/.kimi-code`；仅项目级/历史/服务契约中的已确认字面量保留。
   - 最小可运行检查：运行实现概览第 10 项列出的 `apps/kimi-code`、`apps/kimi-inspect`、`migration-legacy`、agent-core/agent-core-v2、klient 和 minidb 测试；再做一次限定范围的 identity sweep，逐条对照 closure 的分类表。

### 升级策略

- **兼容边界**：fork 包 prelaunch、无 active consumers、无 persisted data；对上游服务的契约（OAuth/UA/遥测）保留不变，不构成本切片的兼容边界。
- **兼容策略状态**：`not-applicable`（npm 包自身）；同机上游用户维度为 `breaking-by-design`（干净切换）。
- **兼容策略来源**：用户选择（D5 干净切换、D6 保留面）+ 事实证据（prelaunch、持久化 key）。
- **兼容策略**：受影响对象 = 同机已装上游的用户；cutover = 首次使用 tea-code 重新 login，配置全新落 `~/.tea-code`；上游 `~/.kimi-code` 保持不动。
- **升级路径**：用户 `npm i -g @futuretea/tea-code`；维护者 push `futuretea` 分支走 changesets 流。
- **回滚方案**：误发布 → `npm deprecate` 或 72h 内 `npm unpublish` + revert 发布 commit；代码变更全部在 `futuretea` 分支，可逐 PR revert。

---

## 质量自检清单

- [x] **当前切片**：只交付身份面切换 + 首次发布；后续增强未进入当前 plan 输入
- [x] **最小范围**：复用中心出口与 Node 内置 fetch；新增仅版本发现切换、native 来源保护与 `+up` 拼接脚本
- [x] **进入计划准备度**：blocking_unknown 为空，assumption 均带证据与回退
- [x] **目标可验证**：G1-G5 全部 acceptance_signal，无伪量化
- [x] **复杂度边界**：无新增依赖 / API / 配置项
- [x] **保护策略**：6 条 guard 全部 accepted，lifecycle/consumer/failure_policy/guard_level 齐备
- [x] **最小验证**：版本发现、native 来源、home 解析、`+up` 拼接均有最小可运行检查
- [x] **读者可执行**：目标、切片、非目标、决策、风险/回退、验证、进入 plan 条件齐备
- [x] **语义完整**：未删除假设、风险、兼容边界或验证义务
- [x] **决策闭合**：版本发现、上游内容资源与 native 更新的边界已由 `decision-record.md` 和用户确认固定
- [x] **去模板化**：无占位符、空表格、HTML 注释

---

## 备注

### 备选方案

| 方案 | 优点 | 缺点 | 不采用原因 |
|------|------|------|------------|
| 本地 `npm publish` 手动发布 | 最简单 | 无 provenance、不可持续 | 用户选择 GHA OIDC |
| 保留上游 CDN 版本检查 | 零改动 | 拿上游版本号装不存在的 fork 版本，必然出错 | 用户选择 npm registry |
| 全量删除或自托管上游内容资源 | 彻底脱离上游 CDN | 改变 marketplace/tips/fd 行为或引入资产与运维面 | 用户选择当前切片保留，后续单独评估 |
| fork native 来源执行上游安装脚本 | 复用现有安装器 | fork 版本发现会安装上游产物 | 用户选择提示 npm 安装 |
| 首次启动迁移 `~/.kimi-code` | 登录态连续 | 并存安装双向污染；迁移代码成本 | 用户选择干净切换 |
| 改 UA + 关遥测 | fork 身份诚实 | 用户选择保留（user_override） | 用户裁决 |
| 项目级 `.kimi-code/` 同步改名 | 身份彻底 | 存量项目兼容面大 | 用户选择不改，列后续增强 |

### 参考资料

- 影响面盘点：`closure.md`（含 sidecar 机械搜索报告索引）
- 决策证据链：`design-interview.md`（10 条用户确认 Q&A）
- 术语：`glossary.md`
- npm trusted publisher 配置指引：`.changeset/README.md`
