# Design Interview：fork 改名发布 @futuretea/tea-code

```yaml
design_interview:
  mode: completed
  skipped_reason: none（align 会话承担首轮访谈，阶段 1 补充 4 条影响面裁决，全部用户确认）
  confirmed_answers:
    - question: 发布方式：本地 npm publish 还是 GitHub Actions？
      answer: 走 GitHub Actions
      evidence: release.yml 已存在 changesets + OIDC（id-token: write）骨架，owner 守卫在 release.yml:14
      confidence: high
      risk_if_wrong: 发布自动化方向错误，workflow 改动返工
      user_answer: 走 GitHub Actions
      final_decision: 使用 GHA OIDC trusted publisher 发布，保留 publishConfig.provenance=true
      decision_source: user_confirmed
      decision_owner: user
      decision_state: accepted
      affects: [scope, acceptance]
      mapped_to: [goals, success_criteria]
    - question: 改名范围：只改 npm 包名，还是 bin、配置目录、更新检查源都改？
      answer: npm 包名、更新检查源、bin、配置目录都要换
      evidence: apps/kimi-code/src/constant/app.ts:38 NPM_PACKAGE_NAME；resolveKimiHome 三处中心出口
      confidence: high
      risk_if_wrong: 改名面界定错误导致 fork 与上游身份混淆
      user_answer: npm 包名和更新检查源，bin，配置目录 都要换
      final_decision: 包名 @futuretea/tea-code、bin tea-code、~/.tea-code、TEA_CODE_HOME 全换
      decision_source: user_confirmed
      decision_owner: user
      decision_state: accepted
      affects: [scope, compatibility, acceptance]
      mapped_to: [goals, decision_tree]
    - question: bin / 配置目录 / 环境变量具体命名？
      answer: bin tea-code；~/.tea-code；TEA_CODE_HOME
      evidence: 用户显式给定；bin code 与 VS Code 冲突已在提问时排除
      confidence: high
      risk_if_wrong: 命名与既有命令冲突或品牌不一致
      user_answer: "bin: tea-code; 配置目录：保持~/.tea-code; 环境变量 TEA_CODE_HOME"
      final_decision: tea-code 三件套
      decision_source: user_confirmed
      decision_owner: user
      decision_state: accepted
      affects: [scope, acceptance]
      mapped_to: [goals, success_criteria]
    - question: 包名是 @futuretea/code 还是 @futuretea/tea-code？
      answer: @futuretea/tea-code
      evidence: 用户在 align 第 4 轮显式改口
      confidence: high
      risk_if_wrong: 发布到错误包名，npm 侧清理成本高
      user_answer: 包名 改成 @futuretea/tea-code
      final_decision: npm 包名 @futuretea/tea-code，与 bin/目录/环境变量统一 tea-code 标识
      decision_source: user_override
      decision_owner: user
      decision_state: accepted
      affects: [scope, acceptance]
      mapped_to: [goals]
    - question: 版本号策略？
      answer: v0.1.0+up0.30.0 格式
      evidence: changesets 只会产生版本本体，+up 后缀需 version:release 自定义拼接；semver 比较忽略 build metadata
      confidence: high
      risk_if_wrong: 版本不可对照上游，或 changesets 发布流拼不出该格式
      user_answer: 版本号 v0.1.0+up0.30.0 这种格式
      final_decision: fork 版本 0.1.0 起步，build metadata 标注上游版本（package.json 内为 0.1.0+up0.30.0）
      decision_source: user_confirmed
      decision_owner: user
      decision_state: accepted
      affects: [acceptance]
      mapped_to: [goals, success_criteria]
    - question: 发布分支与 npm 权限？
      answer: 发布分支 futuretea；已持 @futuretea scope 且可配 trusted publisher
      evidence: 当前工作分支 futuretea；release.yml 触发分支与 changesets baseBranch 均为 main，需改
      confidence: high
      risk_if_wrong: workflow 改动指向错误分支；OIDC 配置缺失导致首次发布失败
      user_answer: futuretea（推荐）/ 有，可以配
      final_decision: 发布分支 futuretea；GHA OIDC，无需 NPM_TOKEN
      decision_source: user_confirmed
      decision_owner: user
      decision_state: accepted
      affects: [scope, acceptance]
      mapped_to: [goals, decision_tree]
    - question: 版本检查/自动更新源：上游 CDN 不可用（fork 不拥有 code.kimi.com），怎么处理？
      answer: 改查 npm registry
      evidence: constant/app.ts:74-79 + src/cli/update/cdn.ts 打上游 latest.json；不改会拿上游版本号安装不存在的 fork 版本
      confidence: high
      risk_if_wrong: 自动更新在后台默认开启，错误源会引导用户执行失败的安装命令
      user_answer: 改查 npm registry（推荐）
      final_decision: 版本发现改查 npm registry 上 @futuretea/tea-code 的 latest；registry 不可达静默跳过的既有行为保留；基于 CDN 的灰度 rollout 元数据随版本元数据查询切换而退化。非版本 CDN 资源的保留见后续 Q&A。
      decision_source: user_confirmed
      decision_owner: user
      decision_state: accepted
      affects: [scope, acceptance, compatibility]
      mapped_to: [goals, success_criteria]
    - question: 配置目录迁移策略：~/.kimi-code 的登录态/配置/会话是否迁移？
      answer: 干净切换
      evidence: fork 与上游并存安装场景下双向污染风险；迁移代码成本高
      confidence: high
      risk_if_wrong: 既有上游用户首次启动 tea-code 需重新 login（已告知用户并接受）
      user_answer: 干净切换（推荐）
      final_decision: 不迁移 ~/.kimi-code、不读取 KIMI_CODE_HOME；首次使用重新 login；migration guard 不适用
      decision_source: user_confirmed
      decision_owner: user
      decision_state: accepted
      affects: [compatibility, acceptance]
      mapped_to: [non_goals, decision_tree]
    - question: 发往上游的 User-Agent 与遥测端点怎么处理？
      answer: 全部保留
      evidence: 用户显式选择对上游服务行为最保守方案
      confidence: high
      risk_if_wrong: fork 身份对上游不透明（UA 仍 kimi-code-cli），fork 遥测打进上游后端——用户已知悉并接受
      user_answer: 全部保留
      final_decision: UA（CLI、kap-server、vscode 三处）与 telemetry-logs.kimi.com 端点保留不改
      decision_source: user_override
      decision_owner: user
      decision_state: accepted
      affects: [scope, compatibility]
      mapped_to: [non_goals]
    - question: 项目级 .kimi-code/ 目录与其余 KIMI_CODE_* 环境变量前缀本轮改吗？
      answer: 都不改
      evidence: 项目目录涉及存量项目兼容；其余 env 多为面向上游服务的覆盖开关（KIMI_CODE_BASE_URL、KIMI_CODE_OAUTH_HOST 等）
      confidence: high
      risk_if_wrong: 改动面扩大、存量项目配置失效——用户选择规避
      user_answer: 都不改（推荐）
      final_decision: 项目级 .kimi-code/ 目录与 KIMI_CODE_* 其余环境变量保持原名，仅 KIMI_CODE_HOME 改 TEA_CODE_HOME
      decision_source: user_confirmed
      decision_owner: user
      decision_state: accepted
      affects: [scope, compatibility]
      mapped_to: [non_goals]
    - question: 除版本检查外，fork 是否暂时保留现有上游 CDN 依赖？
      answer: 暂时保留 marketplace、tips banner、fd 自动下载和 native 安装链接
      evidence: KIMI_CODE_CDN_BASE 同时被 marketplace、fd 与 native 安装命令消费；tips 使用独立 cdn.kimi.com URL。删除或改指会改变这些非版本用户路径。
      confidence: high
      risk_if_wrong: fork 继续依赖上游控制的内容资源；上游撤除或改变资源时，对应功能可能失效或展示不匹配内容。
      user_answer: 暂时保留
      final_decision: 版本发现只切到 npm registry；marketplace、tips、fd 资产与 native URL 暂时保留上游来源，不自托管。
      decision_source: user_confirmed
      decision_owner: user
      decision_state: accepted
      affects: [scope, acceptance, compatibility]
      mapped_to: [goals, non_goals, decision_tree]
    - question: fork 未拥有 native SEA 发布物时，检测到 native 安装来源的 tea-code 应如何更新？
      answer: 禁用 native 更新，提示用户通过 npm 安装 fork 包
      evidence: native 更新会用 fork npm registry 的版本决定触发条件，但现有 Unix 命令执行上游 install.sh；这会把 fork 用户转回上游安装器。
      confidence: high
      risk_if_wrong: 自动或手工更新安装上游产物，违反 fork 身份与 G2 的版本发现边界。
      user_answer: 禁用 native 更新
      final_decision: 未拥有 fork native 发布物时，native 安装来源不执行上游脚本；显示 npm 安装 fork 包的路径。native 自托管另立 enhancement。
      decision_source: user_confirmed
      decision_owner: user
      decision_state: accepted
      affects: [scope, compatibility, acceptance]
      mapped_to: [goals, non_goals, success_criteria]
  unresolved_questions: []
  measurable_goal_gaps: []
```

## 说明

- 前 6 条 Q&A 转录自 align 会话；后 6 条来自阶段 1 影响面闭合与 fresh review 回流后的 needs-policy 裁决（2026-07-29 用户逐条确认）。
- 「UA/遥测全部保留」为 `user_override`（推荐是改 UA + 关遥测），以用户答案为权威，风险已记录。
