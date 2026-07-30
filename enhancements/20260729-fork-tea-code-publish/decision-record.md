# 决策记录：版本发现与上游内容资源边界

## 执行状态

- `tier: A`，`delegation_mode: MUST`，`provider_adapter_ref: /Users/tea/dev/futuretea/skills/skills/orchestration/auto-agent/references/providers/kimi-code.md`。
- 已回流 3 个独立 lens：Builder、Architect、Skeptic；另有 2 个 Research sidecar 完成代码事实核验。
- 用户已确认两项决定：保留非版本上游 CDN 资源；禁用 fork native 来源走上游安装脚本。

## 问题

fork 首发把版本发现切到 npm registry 时，如何处置同一 CDN 基地址下的 marketplace、tips、`fd` 资产和 native 安装脚本，既不误伤已确认的保留面，也不让 fork native 更新回流到上游安装器？

- 类型：Deliberation
- 约束：不做 native SEA 发布、自托管或新基础设施；不改 OAuth、User-Agent、遥测端点；插件 marketplace 内容不改。
- 成功标准：G2 只对版本发现作自指承诺；保留资源、已知限制和 native 更新行为可由 plan 机械实现与验证。

## 选项与裁决

| 选项 | 结论 |
|------|------|
| 仅替换版本发现，保留非版本内容资源 | 采纳。npm registry 只提供 `@futuretea/tea-code` latest；marketplace、tips、`fd` 资产与 native URL 保持上游来源。|
| 本轮停用或删除全部非版本 CDN 资源 | 不采纳。会改变插件、tips 与缺少系统 `fd` 用户的行为，超出当前切片。|
| 本轮自托管所有资源 | 不采纳。需要资产、发布和运维能力，超出当前范围。|
| fork native 来源继续执行上游安装脚本 | 不采纳。fork 版本发现会驱动上游安装器，违反 fork 身份边界。|
| fork native 来源提示 npm 安装 | 采纳。没有 fork native 发布物时，不执行上游脚本；native 自托管单独评估。|

## 多视角结论

- Builder：版本发现请求与安装 transport 必须分开；删共享 CDN 基地址会误伤 marketplace、`fd` 和 native 路径。
- Architect：按资源所有权拆分常量和外部依赖，不新增通用版本源抽象；registry 场景保留既有 telemetry 结构但不再有 CDN manifest。
- Skeptic：fork SEA 若存在会自动执行上游安装器；tips 的上游版本筛选与 `+up` 版本格式可能不匹配，必须显式写成限制。

## 最终决定

1. G2 改为「版本发现自指」，不再宣称全部更新或 CDN 资源去上游化。
2. marketplace、tips、`fd` 资产与 native URL 作为上游内容资源保留，记录所有者、消费者、失败行为和后续替代条件。
3. native 安装来源在 fork 未拥有 native 发布物时禁用上游脚本，改提示 npm 安装 fork 包。
4. 继续保留更新 telemetry 的事件结构；registry 无 manifest 时使用既有无灰度语义。

## 最脆弱前提与反例

- 最脆弱前提：上游持续提供兼容的 marketplace、tips、`fd` 与 native URL；fork 不控制这些资源。
- 已知限制：上游 tips 若含基于版本范围的规则，`0.1.0+up0.30.0` 可能不等同上游 `0.30.0`，导致 banner 未显示或不匹配。当前按用户选择保留，验证触发条件是出现 `banner_min_version`、`banner_max_version` 或精确版本规则。
- 回转条件：fork 决定发布 native SEA、需要自托管任一内容资源，或 tips 版本规则造成可复现用户问题时，另开 enhancement 重新裁决。

## 映射

- proposal：G2、非目标、D4/D9/D10、实现概览、测试计划、保护策略。
- closure：影响面、外部环境数据依赖、场景闭合、Guard Policy Boundary。
- `decision_source`：两项最终政策均为 `user_confirmed`。
