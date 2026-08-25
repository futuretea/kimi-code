# Re-brand Goal Prompt

请基于下面的上下文，生成一个可以在单次执行中完成的 re-brand goal。目标不是重新设计 Kimi Code，也不是维护一个长期分叉；目标是把 fork 收敛成一个上游无需感知的发行版。

## 已核实的基线

- 对比对象：`tea/moonshot-038` 与 `@moonshot-ai/kimi-code@0.38.0`。
- `@futuretea/tea-code@0.3.0` 已发布，对应上游 `0.38.0`。生成新的 goal 时，必须先重新计算相对指定上游基线的差异；不得复用旧 `0.35.0` 的差异统计，也不得把现有 fork 差异全部视为应保留的设计。
- 现有发行身份是 npm 包 `@futuretea/tea-code`、可执行命令 `tea-code`，运行目录是 `TEA_CODE_HOME` 或默认的 `~/.tea-code`。
- `apps/kimi-code/UPSTREAM_VERSION` 记录上游版本；现有 CLI/Web/v2 遥测和 Kimi Host identity 已通过 `getUpstreamVersion()` 把该版本用于对 Kimi 服务端的身份字段。

## 产品意图

这是一个独立安装、独立运行状态的 Tea Code 发行版，但功能上尽量等同于指定上游版本。严格最小化是硬约束：不能因为某个名称含有 `Kimi` 就替换它；每一项差异都必须直接支撑独立安装、用户级运行目录隔离、直接 CLI 入口，或发往 Kimi 服务端的上游版本投影。它只应在以下边界与上游不同：

1. 除浏览器 Web UI 外，npm 包名、安装/更新信息、`tea-code` 命令，以及直接由 CLI/TUI/ACP 输出的 Tea Code 品牌。
2. Tea Code 自己的运行目录：`TEA_CODE_HOME` 优先，否则 `~/.tea-code`；不得读写上游 `KIMI_CODE_HOME` 或 `~/.kimi-code` 的用户状态。
3. 为独立发布、安装、更新上述发行版所必需的最小元数据、构建与发布配置。
4. 对 Kimi 服务端发送的客户端身份必须使用对应的上游版本，而非 fork 发行版本。身份覆盖 Host identity、HTTP User-Agent、CLI/Web/v2 telemetry 及其他实际向 Kimi 服务发送 `version` 或 `client_version` 的路径。上游产品 token 只有在协议或服务端兼容性要求时才保留；不要仅为重命名而改变它。

用户看到的 Tea Code 发行版本与服务端看到的上游版本是两个不同的概念。已发布映射为 Tea Code `0.2.0` 对应 Kimi Code `0.35.0`，Tea Code `0.3.0` 对应 Kimi Code `0.38.0`。后续 goal 必须显式给出新的 Tea Code 与上游版本映射；发行版本用于 `tea-code --version`、npm 更新和本地发行管理，只有网络身份的版本投影为上游版本。

浏览器 Web UI 是明确例外：其独立 `code-app` 源码与 `apps/kimi-code/dist-web` 预构建 bundle 都保留上游 `Kimi Code` 品牌。本 goal 不要求定位、修改或同步该源码/bundle，也不以 Web UI 的标题、文案或静态资源为 Tea Code re-brand 验收项。这个例外不改变 Web/kap-server 发往 Kimi 服务端的版本身份投影要求。

以下是严格最小化的保留规则：

- 除 `KIMI_CODE_HOME` 被 `TEA_CODE_HOME` 替代以隔离用户级运行目录外，保留其他既有环境变量、Kimi 服务协议 token、模型/认证语义、公共 API 元数据和公共 skill ID。
- 仅因产品名而改动日志名、导出 archive 名、临时目录、缓存 basename、内部变量/函数名或测试 fixture 名，不能提高隔离或身份投影能力，必须保持上游名称。
- 运行目录已经隔离时，不再通过改日志或导出文件 basename 做第二层隔离；例如 Tea Code home 内的 `kimi-code.log` 与 `kimi-debug-*.zip` 仍是允许且预期的上游兼容文件名。
- GitHub Actions 正式 release 与 Changesets 配置仅可作最小适配，使 `futuretea/kimi-code` 能以 npm-only 方式发布 `@futuretea/tea-code`；不得新增发布机制、触发发布或改变非 release 路径。不得恢复自动原生构建、Apple 签名/公证或 GitHub Release 原生资产上传；手动和本地原生构建能力不属于本 goal。Nix packaging、PR 预览发布和其他发布自动化同样不属于本 goal，除非目标提出者另行明确要求。
- 正式发布沿用 `.github/workflows/release.yml` 的 Changesets 流程：由 `pnpm changeset version` 生成版本化提交后，直接推送到 `tea/moonshot-038` 触发 npm 发布。发布前由包所有者在 npm 为 `@futuretea/tea-code` 配置 GitHub Actions trusted publisher（仓库 `futuretea/kimi-code`、文件 `release.yml`、允许 `npm publish`）。上述外部配置不在本 goal 中创建或修改。
- Tea Code 版本由独立映射决定。已发布的 `0.3.0` 不得被重新发布；后续 goal 必须显式指定新的上游版本和对应 Tea Code 版本，并使用与该映射相称的 Changeset。不得用上游版本替代 Tea Code 的发行版本，也不得新增直接发布或一次性旁路。

## Goal 必须包含的范围与边界

- 以指定上游 tag 为功能基线。先用 Git 和源码确认每个保留差异的必要性；不要以旧 proposal、README 或现有 fork 文档代替代码事实。
- 覆盖所有实际运行入口，而不局限于主 CLI：CLI/TUI、ACP、Web/kap-server、v2、OAuth/core、插件/工具启动器，以及 inspect/vis 等会解析同一运行目录的本仓库工具。浏览器 Web UI 的品牌和静态资源除外；仍须覆盖其实际 Kimi 出站身份路径。
- 保留用户在 CLI、TUI、文档和发行流程中复制得到的 Tea Code 名称和路径；测试这些文案、恢复命令、环境变量传递、默认路径与隔离行为。不要改动浏览器 Web UI 中保留的 Kimi Code 文案。
- 保留独立发行需要的包名、bin、更新来源和发布配置，但不引入与发行无关的 release 机制、功能分叉、协议变化或上游功能改写。
- 对任何不属于品牌、运行目录、独立发行或上游身份投影的 diff，默认回归上游；只有能给出直接运行时必要性的例外才保留，并记录证据。
- 对名称改动额外证明：它必须是用户输入、复制、执行或安装时直接接触的 Tea Code 名称；否则默认回归上游。不能以“用户可能看到”代替调用点或产品契约证据。
- 不做自动迁移、兼容读取或双写上游用户目录，除非目标提出者另行明确授权。项目级 `.kimi-code/` 约定不是用户运行目录，不能被机械改名。
- 不修改 Kimi 服务端协议、模型行为、认证语义、会话格式或上游业务功能来实现 re-brand。

## 可验证的完成条件

生成的 goal 应把以下内容转成实现验收条件，而不是停留在原则：

1. 从干净的 `HOME` 启动 Tea Code，只创建或使用 `~/.tea-code`；设置 `TEA_CODE_HOME` 时优先使用它；不会读取或写入上游用户运行目录。
2. 上游 `kimi` 与 `tea-code` 可以在同一台机器共存，运行状态、配置、日志、更新状态和会话数据互不覆盖。
3. 用户安装、帮助、恢复提示、更新提示和直接操作文档中的 Tea Code 名称、命令、包名与运行目录一致；不要求改动浏览器 Web UI、协议/API 文档元数据、公共 skill ID 或上游兼容文件名。
4. 在所有可执行的对 Kimi 服务端请求路径中，实际发送的 `version`、`client_version`、Host identity 和相关 User-Agent 版本等于选定上游 tag 的版本；它们绝不泄露 fork 的发行版本。测试应直接断言请求/遥测载荷，而非只断言一个辅助函数。
5. `tea-code --version`、npm 包版本和自更新仍能表达 Tea Code 的发行版本，除非本次明确改变该产品契约。
6. 对比上游 tag 后，剩余 diff 可以逐项归入“直接 CLI/发行品牌”“运行目录”“独立发行”或“上游身份投影”；没有无归属的行为差异，也没有仅重命名协议、API、skill ID、日志/导出/临时文件或内部符号的差异。
7. 运行与变更相称的 typecheck、测试、lint 和打包验证；不通过删除或弱化既有断言取得绿色。

浏览器 Web UI 的 `Kimi Code` 标题、文案、静态资源或其外部 `code-app` 源码不构成上述验收条件，也不得仅为 re-brand 手工编辑 `apps/kimi-code/dist-web`。同样不得仅为 re-brand 改动 OpenAPI/AsyncAPI 标题、HTTP/API 产物名、内置 skill ID、日志/导出/临时文件名，或 `TEA_CODE_HOME` 之外的环境变量。

## 交付形式要求

请输出一个单一、边界清晰的 goal，而不是多个独立目标、长期路线图或泛化的重构建议。goal 要列出基线 ref、允许差异、非目标、验收命令/证据与回滚边界。发现“最小 re-brand”与当前 fork 行为冲突时，优先保留上游功能，并把无法由代码决定的产品取舍列为需要人类确认的问题。
