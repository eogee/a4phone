# DSH workspace 记账归组缺陷（临时外部方案）

本文记录 a4phone 对 DSH（DeepSeek Harness）workspace 记账归组缺陷的临时应对方案。

该内容属于**临时过渡措施与待观察事项**，不是 a4phone 的功能说明，因此不出现在项目 README 中。DSH 官方的修复进展确认后，本文档随之更新或废弃。

## 背景

DSH 存在一个已知缺陷——workspace 注册表的会话记账只在"首次启动"时用 header 归组历史目录，此后产生的会话（旧版 TUI、`dsh headless`、部分启动入口等）只写会话日志、不主动记账，于是永久落在"未分组"。

该行为官方 README 正文有陈述（"Later cwd-only sessions remain Ungrouped."，v0.1.1-rc.2 启动引导段），但并未列入 "Known Limitations and Deferred Work" 一节（该节仅列"会话删除能力缺失""header 索引刷新时机"两条），官方 GitHub（deepseek-ai/deepseek-harness）也无对应 issue。

0.1.2-rc.1 起官方将其改写为**设计契约**——"sessions created afterwards join a workspace only through `attachSession`"，且注明 "current package constraints, not a task backlog"。即官方视角是无修复计划的既定行为，并非待办缺陷。

核实时间：2026-09-03，基于 npm next 0.1.2-rc.1 / GitHub master。

## a4phone 的临时方案

在 DSH 插件（`dsh/lib/index.js`）中加入"孤儿会话自愈"，在每次插件启动时把已持久化但未记账的会话按 `header.cwd` 归入对应项目（必要时自动新建 workspace 记录）。

该方案的特点：

- **幂等**：只处理未记账的会话，重复运行不重复归组；
- **安全**：失败只记日志，不影响插件启动与其他功能；
- **临时**：仅作为 DSH 官方修复记账 bug 之前的过渡措施。

## 迭代检查项

每次功能迭代 / 代码提交前应检查：

1. 检查 DSH 官方（`@deepseek-ai/dsh-workspace`）是否已修复 workspace 记账归组；
2. 若已修复，评估并**移除**本插件中的"孤儿会话自愈"模块（`config.healWorkspaces` 开关可先关闭再删代码）——它是与 a4phone 核心功能无关的冗余设计，不应长期保留；
3. 若未修复，保留本方案，并在核实时更新上文对官方态度的描述（截至 0.1.2-rc.1：官方仍无启动期对账，视为设计契约、无修复计划）。

## 责任划分

- 根因是 DSH 核心 workspace 记账缺陷（DSH 官方应修；注：截至 0.1.2-rc.1 官方将其视为设计契约，未见修复计划）；
- dsh-tui / 旧入口只是"不主动记账"的设计使然，非其锅；
- a4phone 是体验受损方而非制造者。

## 相关文件

- 插件实现：`dsh/lib/index.js`
- 配置开关：`config.healWorkspaces`
- 挂载入口：`src/setup.mjs` 的 `configureDsh()`