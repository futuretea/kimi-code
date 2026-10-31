# Re-brand Goal Prompt

请基于下面的上下文，生成一个可以在单次执行中完成的 re-brand goal。目标不是重新设计 Kimi Code，也不是维护一个长期分叉；目标是把 fork 收敛成一个上游无需感知的发行版。

## 本轮填空

填入：上游 tag `<TAG>`（解引用 commit `<SHA>`）、Tea 版本 `<VER>`（必须等于该 tag）、新线 `tea/moonshot-<N>`。
功能基线只使用这个 tag。`futuretea` 只放提示词；fork `main` 和上游 `main` 都不是基线。不得把 `futuretea` 上该 tag 之后的提交当作功能基线，也不得复用历史差异统计，或把现有 fork 差异全部视为应保留的设计。上一轮发行线只作对照，禁止把新线合并进旧线。

已发布对照：`2.4.0` / `tea/moonshot-240`、`2.3.2` / `tea/moonshot-232`、`2.3.1` / `tea/moonshot-231`。

现有发行身份是 npm 包 `@futuretea/tea-code`、可执行命令 `tea-code`，运行目录是 `TEA_CODE_HOME` 或默认的 `~/.tea-code`。Tea Code 自 `2.1.1` 起与对应 Kimi Code 使用相同版本号，以减少变基时的发行元数据差异。沿用上游 `getVersion()` 和身份传递，不维护 `UPSTREAM_VERSION`、`getUpstreamVersion()` 或独立版本映射机制。

本轮 Tea Code 发行版本、`tea-code --version`、npm 更新目标和默认 Kimi 网络身份版本均为 `<VER>`；ACP 编辑器显示名称为 `Tea Code CLI/<VER>`，Kimi OAuth 身份为 `Kimi Code CLI/<VER>`。沿用后文的产品 token、协议前缀、Web 后缀和 SDK 自定义身份保留规则。

## 切线

每轮填空，不沿用上一轮分支名。下列字面量来自已成功同步 `c2df07c613` 实际改过、旧提示词没有写全的项。

从上一轮 `tea/moonshot-*` 拉出新线后，把下列字面量全部换成新线 `tea/moonshot-<N>`，并在该发行线工作树上用 `git grep tea/moonshot-` 确认没有旧线残留。旧线名字只允许留在明确标成历史对照的文档里（包括上文「已发布对照」这一行）。

- `.github/workflows/ci.yml`：`on.push.branches`、`concurrency.group`、`cancel-in-progress`（三处一起改；漏掉 push 分支则合并后没有 push CI，npm 发不出）
- `.github/workflows/release.yml`：`on.push.branches`、`version` job 的 `if`、`candidate` job 的 `if`（不能只改 push）
- `.changeset/config.json` 的 `baseBranch`
- `scripts/release-trigger.mjs` 的分支判断，以及 `scripts/release-trigger.test.mjs` 的 `const branch`；把上一轮分支放进拒绝用例
- `README.md`、`README.zh-CN.md` 的 `git clone --branch`；`apps/kimi-code/README.md` 的 blob 链接；`apps/kimi-code/package.json` 的 `homepage`

版本：`apps/kimi-code/package.json` 保持上一已发布 Tea 版本。把仍指向 `@moonshot-ai/kimi-code` 的 changeset 改挂 `@futuretea/tea-code`。改挂后的最高 bump 只能等于「已发布版本 → `<VER>`」的距离；该距离是 patch 时，minor 和 major 都降为 patch。禁止为了凑 bump 改共享包的发布方式。Tea 版本必须等于上游 tag。

发版：只等待或手工打开 `changeset-release/tea/moonshot-<N>` → `tea/moonshot-<N>`（形态同 #1、#2、#3）。不要开同步 PR 把新线合进旧线（#4 那种）。若 Actions 未开「Allow GitHub Actions to create and approve pull requests」、因而不能创建 PR，按同一头尾手工开。合并后，`release-trigger.mjs` 只认该合并提交上 `ci.yml` 的 **push** run；PR CI 通过不等于可以发布。普通推送不发布。

## 产品意图

这是一个独立安装、独立运行状态的 Tea Code 发行版，但功能上尽量等同于指定上游版本。严格最小化是硬约束：不能因为某个名称含有 `Kimi` 就替换它；每一项差异都必须直接支撑独立安装、用户级运行目录隔离、直接 CLI 入口，或发往 Kimi 服务端的客户端身份。它只应在以下边界与上游不同：

1. 除浏览器 Web UI 外，npm 包名、安装/更新信息、`tea-code` 命令，以及直接由 CLI/TUI/ACP 输出的 Tea Code 品牌。
2. Tea Code 自己的运行目录：`TEA_CODE_HOME` 优先，否则 `~/.tea-code`；不得读写上游 `KIMI_CODE_HOME` 或 `~/.kimi-code` 的用户状态。
3. 为独立发布、安装、更新上述发行版所必需的最小元数据、构建与发布配置。
4. 本发行提供的默认 Kimi 客户端身份必须使用选定上游版本，数值与 Tea Code 发行版本一致。身份覆盖 Host identity、HTTP User-Agent、CLI/Web/v2 telemetry 及其他实际向 Kimi 服务发送 `version` 或 `client_version` 的路径。保留上游规定的产品 token、协议前缀和 Web 后缀，不因 CLI 改名而改变它们；SDK 调用方自定义的身份保持原值。

Tea Code 发行版本用于 `tea-code --version`、npm 更新和本地发行管理；Kimi 网络身份版本用于上游服务识别。两者用途不同，当前及后续发行的数值相同。旧发行曾使用独立映射：Tea Code `0.2.0` 对应 Kimi Code `0.35.0`，`0.3.0` 对应 `0.38.0`，`0.4.0` 对应 `0.41.0`；不要将旧机制带入新的 goal。

浏览器 Web UI 是明确例外：其独立 `code-app` 源码与 `apps/kimi-code/dist-web` 预构建 bundle 都保留上游 `Kimi Code` 品牌。本 goal 不要求定位、修改或同步该源码/bundle，也不以 Web UI 的标题、文案或静态资源为 Tea Code re-brand 验收项。这个例外不改变 Web/kap-server 发往 Kimi 服务端的客户端身份要求。

以下是严格最小化的保留规则：

- 父 CLI 的用户级运行目录只由 `TEA_CODE_HOME` 或默认 `~/.tea-code` 决定，忽略父环境的 `KIMI_CODE_HOME`。插件 MCP 与 hook 子进程保留上游 `KIMI_CODE_HOME` 输入契约，同时提供 `TEA_CODE_HOME`；两者必须强制指向已经解析的 Tea home，不得继承指向上游目录的值。默认市场实际下载的上游插件也必须满足此隔离，不能只验证工作树中的插件源码。保留其他既有环境变量、Kimi 服务协议 token、模型/认证语义、公共 API 元数据和公共 skill ID。
- 仅因产品名而改动日志名、导出 archive 名、临时目录、缓存 basename、内部变量/函数名或测试 fixture 名，不能提高隔离或网络身份正确性，必须保持上游名称。
- 运行目录已经隔离时，不再通过改日志或导出文件 basename 做第二层隔离；例如 Tea Code home 内的 `kimi-code.log` 与 `kimi-debug-*.zip` 仍是允许且预期的上游兼容文件名。
- GitHub Actions 正式 release 与 Changesets 配置仅可作最小适配，使 `futuretea/kimi-code` 能以 npm-only 方式发布 `@futuretea/tea-code`；不得新增发布机制或改变非 release 路径。正式 release 不联动部署文档，不恢复自动原生构建、Apple 签名/公证或 GitHub Release 原生资产上传；保留手动和本地原生构建能力及其上游名称。Nix packaging、PR 预览发布和其他发布自动化不属于本 goal，除非目标提出者另行明确要求。
- 正式发布只沿用 `.github/workflows/release.yml` 的 Changesets 流程，按「切线」一节替换分支字面量，并由 `pnpm changeset version` 生成目标版本 `<VER>`。发布授权是把 `changeset-release/tea/moonshot-<N>` 合并进 `tea/moonshot-<N>`；`release-trigger.mjs` 只认该合并提交上 `ci.yml` 的 push run。PR CI 通过不等于可以发布，普通推送不发布，也不得把新线合进旧线。npm trusted publisher 使用仓库 `futuretea/kimi-code`、文件 `release.yml`；本 goal 不默认创建或修改该外部配置，也不默认执行提交、推送、打 tag、发布或部署。
- Tea Code 版本必须等于选定上游 tag，即 `<VER>`。切线时 `apps/kimi-code/package.json` 保持上一已发布 Tea 版本。把仍指向 `@moonshot-ai/kimi-code` 的 changeset 改挂 `@futuretea/tea-code`；改挂后的最高 bump 只能等于「已发布 Tea 版本 → `<VER>`」的距离，该距离是 patch 时 minor 和 major 都降为 patch。禁止为了凑 bump 改共享包的发布方式，不改变共享包版本，也不新增长期版本校正机制、直接发布或一次性旁路。不得因版本化再次递增而交付不同于 `<VER>` 的版本。发布前确认该 Tea Code 版本尚未发布。若目标版本已发布，不擅自加补丁号或改回独立映射，交由目标提出者决定下一版本。
- Tea Code 安装和更新使用 `@futuretea/tea-code` 的 npm 发行来源，不自动下载上游 Kimi 原生发行物。普通启动不探测旧 Python `~/.kimi`；只在用户主动执行 `tea-code migrate` 时使用既有迁移能力，保留该显式命令的上游源标记语义。
- ACP 的编辑器显示名称与 Kimi 网络身份分开：显示 `Tea Code CLI/<VER>`，Kimi OAuth 使用 `Kimi Code CLI/<VER>`。沿用已支持的可选网络身份参数；未传该参数的调用方维持上游行为，不为品牌增加 ACP 模型请求字段，也不强制覆盖 SDK 调用方的自定义身份。

## Goal 必须包含的范围与边界

- 以指定上游 tag `<TAG>`（解引用 commit `<SHA>`）为功能基线。`futuretea` 只放提示词；fork `main` 与上游 `main` 都不是功能基线。先用 Git 和源码确认每个保留差异的必要性；不要以旧 proposal、README 或现有 fork 文档代替代码事实。
- 覆盖所有实际运行入口，而不局限于主 CLI：CLI/TUI、ACP、Web/kap-server、v2、OAuth/core、插件/工具启动器，以及 inspect/vis 等会解析同一运行目录的本仓库工具。浏览器 Web UI 的品牌和静态资源除外；仍须覆盖其实际 Kimi 出站身份路径。
- 保留用户在 CLI、TUI、文档和发行流程中复制得到的 Tea Code 名称和路径；测试这些文案、恢复命令、环境变量传递、默认路径与隔离行为。不要改动浏览器 Web UI 中保留的 Kimi Code 文案。
- 保留独立发行需要的包名、bin、更新来源和发布配置，但不引入与发行无关的 release 机制、功能分叉、协议变化或上游功能改写。
- 对任何不属于品牌、运行目录、独立发行或上游身份的 diff，默认回归上游；只有能给出直接运行时必要性的例外才保留，并记录证据。
- 对名称改动额外证明：它必须是用户输入、复制、执行或安装时直接接触的 Tea Code 名称；否则默认回归上游。不能以“用户可能看到”代替调用点或产品契约证据。
- 不做自动迁移、兼容读取或双写上游用户目录，除非目标提出者另行明确授权。显式 `tea-code migrate` 读取旧 Python 目录是已确认的迁移入口，不属于普通启动；不将它扩展为自动读取或迁移 `~/.kimi-code`。项目级 `.kimi-code/` 约定不是用户运行目录，不能被机械改名。
- 不修改 Kimi 服务端协议、模型行为、认证语义、会话格式或上游业务功能来实现 re-brand。
- 所有运行和测试验证使用一次性凭证、临时 `HOME` 和独立 Tea/Kimi 测试目录；在启动测试进程前设置隔离环境，不访问或改动真实用户状态。

## 可验证的完成条件

生成的 goal 应把以下内容转成实现验收条件，而不是停留在原则：

1. 在临时 `HOME` 下验证未设变量、仅设置 `TEA_CODE_HOME`、仅设置 `KIMI_CODE_HOME`、两者同时设置四种情况。Tea Code 优先使用 Tea home，否则默认 `~/.tea-code`，忽略上游 home 变量。通过实际读写、访问记录和上游测试目录内容不变证明隔离；普通启动不探测旧 Python 目录，显式迁移按上述例外单独验证。
2. 上游 `kimi` 与 `tea-code` 可以在同一台机器共存，运行状态、配置、日志、更新状态和会话数据互不覆盖。
3. 用户安装、帮助、恢复提示、更新提示和直接操作文档中的 Tea Code 名称、命令、包名与运行目录一致；不要求改动浏览器 Web UI、协议/API 文档元数据、公共 skill ID 或上游兼容文件名。
4. 在所有可执行的 Tea Code 默认 Kimi 客户端身份路径中，实际发送的 `version`、`client_version`、Host identity 和相关 User-Agent 版本等于选定上游 tag 的版本，也等于 Tea Code 发行版本；保留上游产品 token、前缀和 Web 后缀。SDK 调用方自定义的身份保持原值，单独验证，不强制套用默认身份的版本等值断言。测试应直接断言请求/遥测载荷，而非只断言一个辅助函数。
5. `tea-code --version`、npm 包版本和自更新目标都等于选定上游 tag 的版本；打包后核对元数据和实际安装入口，不以版本常量断言代替。
6. 对比上游 tag 后，剩余 diff 可以逐项归入“直接 CLI/发行品牌”“运行目录”“独立发行”或“上游身份”；没有无归属的行为差异，也没有仅重命名协议、API、skill ID、日志/导出/临时文件或内部符号的差异。`dist-web` 与该 tag 的 bundle 逐字节一致。
7. 运行与变更相称的 typecheck、测试、lint 和打包验证；不通过删除或弱化既有断言取得绿色。

浏览器 Web UI 的 `Kimi Code` 标题、文案、静态资源或其外部 `code-app` 源码不构成上述验收条件，也不得仅为 re-brand 手工编辑 `apps/kimi-code/dist-web`。同样不得仅为 re-brand 改动 OpenAPI/AsyncAPI 标题、HTTP/API 产物名、内置 skill ID、日志/导出/临时文件名，或 `TEA_CODE_HOME` 之外的环境变量。

## 交付形式要求

请输出一个单一、边界清晰的 goal，而不是多个独立目标、长期路线图或泛化的重构建议。goal 要列出基线 ref、允许差异、非目标、验收命令/证据与回滚边界。发现“最小 re-brand”与当前 fork 行为冲突时，优先保留上游功能，并把无法由代码决定的产品取舍列为需要人类确认的问题。
