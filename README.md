# a4phone

Claude Code / Codex 远程手机交互包。通过 [ntfy.sh](https://ntfy.sh) 在手机上接收任务完成通知（含 AI 最后输出），对 AI 提问与权限请求进行远程点选或文字作答，并可从手机直接继续对话。

## 功能

- **任务完成通知**：`Stop` 事件 → 电脑弹窗 + 手机推送，包含 AI 最后输出的一段话
- **AI 提问交互**：`AskUserQuestion` → 手机显示选项按钮点选，也可直接发送文字自由作答
- **权限请求交互**：`PermissionRequest` → 手机 Approve/Deny/Always Approve
- **远程续聊**：守护进程监听主话题，手机发文字即可与当前会话交流，形成完整远程对话闭环
- **实时终端注入**：优先把手机消息实时"打字"进正在运行的 Claude Code 终端窗口，Claude 在终端里原位回复
- **后台守护进程**：`a4p listen` 无窗口后台运行，日志写入文件
- **双模式**：外出模式（手机优先）/ 终端优先模式，一键切换
- **零第三方依赖**：仅依赖 ntfy.sh 免费服务，无 Google 服务依赖

## 安装

```bash
npm install -g a4phone
```

## 使用

```bash
a4p setup        # 安装引导：生成话题、注册 Hook、显示二维码
a4p out          # 外出模式（手机优先）
a4p home         # 终端优先模式（默认）
a4p status       # 查看当前模式
a4p listen       # 后台运行续聊守护进程（无窗口）
a4p listen --stop     # 停止守护进程
a4p listen --status   # 查看守护进程状态
a4p resume       # 手动续聊最近会话：a4p resume 要追加的内容
a4p last         # 查看最近会话记录
a4p test         # 发送测试通知
a4p uninstall    # 移除 Hook 和配置
```

### 安装引导

`a4p setup` 自动完成：

1. 生成独一无二的话题名称（如 `a4p-xxxx`），写入 `~/.a4phone.json`
2. 在 `~/.claude/settings.json` 注册三个 Hook（Stop / AskUserQuestion / PermissionRequest）
3. 在终端显示二维码

然后用手机 ntfy App 扫描二维码或输入话题名称订阅，重启 Claude Code 会话生效。

### 模式切换

```bash
a4p out        # 外出模式：提问/权限请求优先推送手机，超时终端兜底
a4p home       # 终端优先模式（默认）：直接走终端，手机不参与
a4p status     # 查看当前模式
```

> 切换即时生效，无需重启会话。

### AI 最后输出

`Stop` 事件触发时，a4phone 读取会话记录（transcript），把 AI 最后输出的一段话（截断到 1000 字符）连同目录、会话 ID 一起推送手机，让你离开电脑也能看到任务的实际结果。

### 手机自由文本作答

`AskUserQuestion` 提问推送手机后，除了点选选项按钮，还可以**直接向响应话题 `{topic}-response` 发送文字**作为答案，自由回答不受选项限制。

### 远程续聊

在手机端直接向**主话题 `{topic}`** 发送文字，即可与当前 Claude Code 会话继续对话——无需额外的续聊话题，你订阅的通知话题就是对话通道。

1. 启动续聊守护进程（后台无窗口运行）：

   ```bash
   a4p listen            # 后台运行
   a4p listen --status   # 查看状态
   a4p listen --stop     # 停止
   ```

   日志写入 `~/.a4phone-daemon.log`。

2. 手机 ntfy App 已订阅主话题 `{topic}`（`a4p setup` 生成，扫描二维码即可），向该话题发送任意文字即可。

3. 守护进程收到手机消息后，**优先实时注入**到正在运行的 Claude Code 终端窗口（Claude 在终端里原位回复）；若找不到匹配窗口则回退执行 `claude --resume <最近会话> --continue` 处理，结果推回手机。

4. 无需守护进程时，也可在电脑上手动续聊：

   ```bash
   a4p resume 帮我总结一下刚才的改动
   ```

5. 查看最近会话记录：

   ```bash
   a4p last
   ```

> 续聊仅支持 Claude Code 会话。续聊回合内若再次触发提问/权限请求，仍会推送手机，形成完整的远程对话闭环。

### 实时终端注入

守护进程收到手机消息后，会**优先尝试实时注入**正在运行的 Claude Code 终端窗口：用 Windows 控制台 API（`AppActivate` + 剪贴板粘贴）把消息"打字"进终端，Claude 在终端里原位回复，回复再提取推回手机。注入失败时自动回退到 `--resume` 续聊。

实时注入靠**窗口标题关键字**匹配终端窗口，默认匹配含 `claude code` 的标题。若你的终端标题不含该关键字，可在 `~/.a4phone.json` 配置：

```json
{ "windowPattern": "你的终端标题关键字" }
```

> **实验性**：实时注入依赖窗口标题精确匹配、需前台焦点，会抢占终端并可能打断正在进行的操作；且无法直接捕获 AI 回复（靠轮询会话记录提取，best-effort）。

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

Claude Code Hook 拦截事件后，通过 ntfy.sh 推送带按钮的通知到手机；手机点选或发送文字后，决策经响应话题回传并注入会话。`Stop` 事件同时把 AI 最后输出从会话记录中抽取出来推送手机。

```
AI助手触发事件 → a4p hook → ntfy.sh 推送手机 → 手机点选/文字作答 → 决策回传 → 注入会话
```

远程续聊的闭环：

```
手机向 {topic} 发文字 → 守护进程 a4p listen
  → 实时注入终端窗口（优先）或 claude --resume --continue（回退）
  → AI 回复写入会话并回推手机
```

### Hook 输出格式

- 提问（PreToolUse）：`hookEventName: "PreToolUse"` + `permissionDecision: "allow"` + `updatedInput.answers`
- 权限请求（PermissionRequest）：`hookEventName: "PermissionRequest"` + `decision.behavior`

## 注意事项

- 需 Node.js 18+，手机端安装 ntfy App
- 手机订阅后，请在**订阅设置**中开启"即时交付"，否则消息需手动刷新才能收到
- 续聊仅支持 Claude Code 会话；`Codex` 会话触发 `Stop` 时会记录最近会话，但续聊命令会拒绝执行
- 续聊期间守护进程会自动临时切换为外出模式，结束后恢复原模式
- 一个会话同一时间只能被一个进程占用，`--resume` 续聊前请先结束终端里仍在运行的原会话（实时注入方式不受此限制）
- 续聊守护进程需后台常驻：Windows 用 `a4p listen` 或计划任务，WSL/Linux 可用 tmux 或 systemd
- **ntfy.sh 免费托管服务有发布速率/消息保留限制**：短时间高频测试可能触发 `limited` 提示，建议降低推送频率（续聊结果已去重推送，不再重复通知）
- ntfy.sh 公共话题可被知晓话题名的人读写，重要场景建议自建 ntfy 服务或使用访问令牌
- ntfy.sh 为国外服务，国内网络下长连接可能不稳定
- 配置存储于 `~/.a4phone.json`（含 `windowPattern`），最近会话存储于 `~/.a4phone-last.json`，模式存储于 `~/.a4phone-mode.json`，守护进程信息存储于 `~/.a4phone-daemon.json`

## 开发

```bash
npm install              # 安装依赖
node bin/a4p.mjs setup   # 本地调试
```

## 开源协议

[MIT](LICENSE)
