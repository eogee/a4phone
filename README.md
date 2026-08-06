# a4phone

Claude Code / Codex 远程手机交互包。通过 [ntfy.sh](https://ntfy.sh) 在手机上接收任务完成通知，并对 AI 提问与权限请求进行远程点选确认。

## 功能

- **任务完成通知**：`Stop` 事件 → 电脑弹窗 + 手机推送（含目录、会话信息）
- **AI 提问交互**：`AskUserQuestion` → 手机显示选项按钮，点选后答案回传会话
- **权限请求交互**：`PermissionRequest` → 手机 Approve/Deny/Always Approve
- **双模式**：外出模式（手机优先）/ 终端优先模式，一键切换
- **零第三方依赖**：仅依赖 ntfy.sh 免费服务，无 Google 服务依赖

## 安装

```bash
npm install -g @eogee/a4phone
```

## 使用

```bash
a4p setup      # 安装引导：生成话题、注册 Hook、显示二维码
a4p out        # 外出模式（手机优先）
a4p home       # 终端优先模式（默认）
a4p status     # 查看当前模式
a4p test       # 发送测试通知
a4p uninstall  # 移除 Hook 和配置
```

### 安装引导

`a4p setup` 自动完成：

1. 生成独一无二的话题名称（如 `a4p-xxxx`），写入 `~/.a4phone.json`
2. 在 `~/.claude/settings.json` 注册三个 Hook（Stop / AskUserQuestion / PermissionRequest）
3. 在终端显示二维码

然后用手机 ntfy App 扫描二维码或输入话题名称订阅，重启 Claude Code 会话生效。

### 模式切换

```bash
a4p out        # 外出模式：提问/权限请求优先推送手机，超时兜底终端
a4p home       # 终端优先模式（默认）：直接走终端，手机不参与
a4p status     # 查看当前模式
```

> 切换即时生效，无需重启会话。

## Codex

`a4p setup` 会同时自动配置 Claude Code 和 Codex。Codex 配置追加到 `~/.codex/config.toml` 末尾（保留原有设置），结构如下：

```toml
[features]
hooks = true

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "a4p hook"

[[hooks.PreToolUse]]
matcher = "AskUserQuestion"
[[hooks.PreToolUse.hooks]]
type = "command"
command = "a4p hook"

[[hooks.PermissionRequest]]
[[hooks.PermissionRequest.hooks]]
type = "command"
command = "a4p hook"
```

> 注意：启用项必须放在 `[features]` 表内（`[features] hooks = true`），不能写成根级别的裸 `hooks = true`，否则与 `[[hooks.*]]` 冲突导致 TOML 解析错误。Codex 会话中需运行 `/hooks` 并手动信任新 Hook。

## 原理

Claude Code Hook 拦截事件后，通过 ntfy.sh 推送带按钮的通知到手机；手机点击后，决策经响应话题回传并注入会话。

```
AI助手触发事件 → a4p hook → ntfy.sh 推送手机 → 手机点选 → 决策回传 → 注入会话
```

### Hook 输出格式

- 提问（PreToolUse）：`hookEventName: "PreToolUse"` + `permissionDecision: "allow"` + `updatedInput.answers`
- 权限请求（PermissionRequest）：`hookEventName: "PermissionRequest"` + `decision.behavior`

## 注意事项

- 需 Node.js 18+，手机端安装 ntfy App
- 手机订阅后，请在**订阅设置**中开启"即时交付"，否则消息需手动刷新才能收到
- ntfy.sh 为国外服务，国内网络下长连接可能不稳定
- 配置存储于 `~/.a4phone.json`，模式存储于 `~/.a4phone-mode.json`

## 开发

```bash
npm install              # 安装依赖
node bin/a4p.mjs setup   # 本地调试
```

## 开源协议

[MIT](LICENSE)
