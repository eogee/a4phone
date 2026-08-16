![a4phone](resource/a4phone-cover.jpg)

# a4phone

DSH（DeepSeek Harness）/ Claude Code / Codex 远程手机交互包。通过 [ntfy.sh](https://ntfy.sh) 在手机上接收任务完成通知（含 AI 最后输出），对 AI 提问与权限请求进行远程点选或文字作答，并可从手机直接继续对话。

## 功能

- **任务完成通知**：`Stop` 事件（DSH 为 `turn/end`）→ 电脑弹窗 + 手机推送，包含 AI 最后输出的一段话
- **AI 提问交互**：`AskUserQuestion`（Codex 为 `request_user_input`，DSH 为 `ask_user_question`）→ 手机显示选项按钮点选，也可直接发送文字自由作答
- **权限请求交互**：`PermissionRequest` → 手机 Approve/Deny/Always Approve
- **DSH 一键挂载**：`a4p setup` 自动把内置 `dsh-hook` 插件挂到 DSH web profile，让 DeepSeek Harness 同样具备手机交互
- **远程续聊**：守护进程监听主话题，手机发文字即可与当前会话交流，形成完整远程对话闭环（DSH / Claude Code / Codex）
- **DSH 远程续聊**：手机发文字直接注入 DSH 正在运行的会话（`agent.followup`），手机消息与 AI 回复**实时出现在桌面端会话里**，无需另起进程、无会话锁冲突
- **后台守护进程**：`a4p listen` 无窗口后台运行，日志写入文件
- **自动更新提醒**：守护进程周期检查 npm 新版本并**推送手机提醒**；其他命令发现新版本时终端提示 + 手机推送（默认开启，可在配置关闭）
- **双模式**：外出模式（手机优先）/ 终端优先模式，一键切换
- **零第三方依赖**：仅依赖 ntfy.sh 免费服务，无 Google 服务依赖

## 安装

```bash
npm install -g a4phone
```

## 使用

```bash
a4p setup        # 安装引导：生成话题、注册 Hook、启动守护进程、注册开机自启、显示二维码
a4p out          # 外出模式（手机优先）
a4p home         # 终端优先模式（默认）
a4p status       # 查看当前模式
a4p listen       # 后台运行续聊守护进程（无窗口）
a4p listen --stop     # 停止守护进程
a4p listen --status   # 查看守护进程状态
a4p autostart    # 查看开机自启状态（--on 开启 / --off 关闭）
a4p resume       # 手动续聊最近会话：a4p resume 要追加的内容
a4p last         # 查看最近会话记录
a4p test         # 发送测试通知
a4p uninstall    # 移除 Hook 和配置
a4p --version    # 查看版本号
a4p help         # 显示帮助
```

### 安装引导

`a4p setup` 自动完成：

1. 生成独一无二的话题名称（如 `a4p-xxxx`），写入 `~/.a4phone/config.json`
2. 在 `~/.claude/settings.json` 注册三个 Hook（Stop / AskUserQuestion / PermissionRequest），并同时写入 `~/.codex/config.toml` 的 Codex Hook（见下文 [Codex](#codex) 一节）
3. 检测到 DSH 环境时，把内置 `dsh-hook` 插件挂载到 `~/.dsh/profiles/web/cordis.patch.yml`（见下文 [DSH](#dshdeepseek-harness) 一节）
4. **默认启动续聊守护进程**（`a4p listen` 后台运行）
5. **默认注册开机自启**（Windows 启动文件夹写入隐藏 VBS，登录时自动运行守护进程）
6. 在终端显示二维码

然后用手机 ntfy App 扫描二维码或输入话题名称订阅；DSH 插件热生效无需重启，重启 Claude Code / Codex 会话后 Hook 生效。

> 开机自启无需管理员权限（当前用户启动文件夹），可用 `a4p autostart --off` 关闭、`--on` 重新开启；`a4p uninstall` 会一并移除。WSL/Linux 暂不支持自动注册，可手动用 tmux / systemd 常驻。

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

`AskUserQuestion` 提问推送手机后，除了点选选项按钮，还可以**直接向响应话题 `{topic}-response` 发送文字**作为答案，自由回答不受选项限制。ntfy 单条推送最多 3 个按钮，选项超过 3 个时自动降级为编号列表，回复对应编号即可选中选项。

### 远程续聊

在手机端直接向**主话题 `{topic}`** 发送文字，即可与最近会话（DSH / Claude Code / Codex）继续对话——无需额外的续聊话题，你订阅的通知话题就是对话通道。

1. 启动续聊守护进程（后台无窗口运行）：

   ```bash
   a4p listen            # 后台运行
   a4p listen --status   # 查看状态
   a4p listen --stop     # 停止
   ```

   日志写入 `~/.a4phone/daemon.log`。

2. 手机 ntfy App 已订阅主话题 `{topic}`（`a4p setup` 生成，扫描二维码即可），向该话题发送任意文字即可。

3. 守护进程收到手机消息后，按最近会话的 agent 执行续聊（DSH：经文件队列交给 `dsh web` 进程内的插件直接 `followup` 到当前 live 会话；Claude Code：`claude --resume <会话> --continue -p`；Codex：`codex exec resume <会话> -o <临时文件> -`，`-o` 捕获最后一条回复）。均为 headless，捕获回复后推回手机。Codex 会话若被窗口占用（thread-store conflict），a4phone 会自动把它 fork 成新线程续聊——**不需要关闭原窗口**，原会话原样保留，手机对话在 fork 上继续。

4. 无需守护进程时，也可在电脑上手动续聊：

   ```bash
   a4p resume 帮我总结一下刚才的改动
   ```

5. 查看最近会话记录：

   ```bash
   a4p last
   ```

> 续聊完全 headless 运行（无需窗口标题匹配、前台焦点或剪贴板，也不依赖你当前是否开着终端），支持 DSH、Claude Code 与 Codex 会话（按最近会话的 agent 自动选择续聊方式）。续聊回合内若再次触发提问/权限请求，仍会推送手机，形成完整的远程对话闭环。
>
> **积压合并**：一轮续聊最长可达 `resumeTimeout`（默认 30 分钟），期间手机连续发来的消息会自动**合并为一个批次**一次性续聊（不再逐条排队、每条一个独立轮次），保证手机内容一定能送达 AI；积压批次持久化到 `~/.a4phone/pending-batch.json`，守护进程重启/崩溃后自动恢复，不丢消息。

## Codex

`a4p setup` 会同时自动配置 Claude Code 和 Codex。Codex 配置追加到 `~/.codex/config.toml` 末尾（保留原有设置），结构如下：

```toml
[features]
hooks = true

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "a4p hook codex"

[[hooks.PreToolUse]]
matcher = "request_user_input"
[[hooks.PreToolUse.hooks]]
type = "command"
command = "a4p hook codex"

[[hooks.PermissionRequest]]
[[hooks.PermissionRequest.hooks]]
type = "command"
command = "a4p hook codex"
```

> 注意：启用项必须放在 `[features]` 表内（`[features] hooks = true`），不能写成根级别的裸 `hooks = true`，否则与 `[[hooks.*]]` 冲突导致 TOML 解析错误。Codex 会话中需运行 `/hooks` 并手动信任新 Hook。
>
> Codex 的提问工具叫 `request_user_input`（不是 `AskUserQuestion`），PreToolUse 的 matcher 必须匹配该名称 hook 才会触发。Codex 端无法像 Claude Code 那样用 `updatedInput` 注入答案，a4phone 采用"阻断工具调用、把手机答案写进阻断原因"的方式，让模型看到答案后直接采用继续。

## DSH（DeepSeek Harness）

`a4p setup` 检测到 DSH 环境（`~/.dsh/profiles/web` 存在）时，会把内置的 `dsh-hook` 插件挂载到 web profile 的 `cordis.patch.yml`，让 DeepSeek Harness 同样具备手机远程交互。插件复用同一 a4phone 话题与模式，手机端无需额外订阅。

| Hook | 触发事件 | 手机交互（外出模式） |
|------|---------|---------------------|
| 任务完成 | `turn/end` 且 `reason.kind === 'completed'` | 系统通知 + 手机推送（含 AI 最后输出） |
| 提问 | `ask_user_question` 工具调用 | 手机点选选项 / 文字自由作答 |
| 权限请求 | `approval/request` | 手机 Approve / Deny |
| 远程续聊 | 文件队列 `~/.a4phone/dsh-jobs/`（a4p 写请求，插件回复） | 手机发文字 → `agent.followup` 注入当前会话 → 回复推回手机 |

- 插件位于本包 `dsh/` 目录（Cordis 插件，监听 DSH 的 `session/event`、`tools/execute`、`approval/request` 事件），`a4p setup` 以 insert 形式写入 patch，幂等可重复执行
- 若检测到旧版手动挂载（指向 `C:\ProgramMine\dsh-hook` 的 `id: dsh-hook`），`a4p setup` 会自动替换为本包路径
- `cordis.patch.yml` 被 DSH 热监视（`watchUserPatches`），挂载即时生效；若插件代码有更新，建议重启 `dsh web`（可参考 `restart-dsh-web.ps1` 的思路）
- 模式切换复用同一套：`a4p out`（手机优先）/ `a4p home`（终端优先）；Hook 日志写入 `~/.a4phone/dsh-logs/`
- 目前仅挂载到 `web` profile；`a4p uninstall` 会同时移除该挂载

### DSH 远程续聊

手机向主话题发文字即可继续 DSH 会话，机制与 Claude Code / Codex 的续聊不同：

1. **记录最近会话**：插件在每次顶层会话 `turn/end`（completed）时写入 `~/.a4phone/last.json`（`agent: "DSH"`），与 Claude Code / Codex 的 Stop Hook 一致
2. **文件队列协议**：`a4p resume` / `a4p listen` 把手机消息原子写入 `~/.a4phone/dsh-jobs/req-<id>.json`；插件每秒扫描，处理后写 `resp-<id>.json`，a4p 轮询取回并推回手机；插件同时刷新 `~/.a4phone/dsh-heartbeat.json` 心跳，a4p 据此快速判断 `dsh web` 是否在运行（未运行会快速失败而非干等超时）
3. **注入到桌面会话**：插件用 `agent.followup()` 把手机文字作为普通 `user/message` 写入**桌面上正在运行的同一个会话**（`ctx.agents` 解析：优先 `last.json` 记录的会话，兜底最近顶层会话），`await agent.whenIdle()` 等待轮次结束，提取最后一条 assistant 文本回推——手机消息与 AI 回复都会**实时出现在桌面端会话里**，桌面与手机看到同一段对话
4. **无会话锁冲突**：不另起进程，所以不存在 Claude Code `--resume` 式的独占锁问题；续聊轮次内若触发提问/审批，仍走手机交互，形成完整闭环
5. 续聊轮次的"任务完成"推送已自动去重（回复由 a4p 推回，插件不再重复通知）

> 前提：`dsh web` 正在运行且已挂载新版 `dsh-hook` 插件（`a4p setup` 自动挂载，插件代码更新后需重启 `dsh web`）。未检测到 `dsh web` 时续聊会快速失败并给出提示。

## 原理

DSH 插件与 Hook（Claude Code / Codex）拦截事件后，通过 ntfy.sh 推送带按钮的通知到手机；手机点选或发送文字后，决策经响应话题回传并注入会话。`Stop` 事件同时把 AI 最后输出从会话记录中抽取出来推送手机。

```
AI助手触发事件 → a4p hook → ntfy.sh 推送手机 → 手机点选/文字作答 → 决策回传 → 注入会话
```

远程续聊的闭环：

```
手机向 {topic} 发文字 → 守护进程 a4p listen
  → 或 DSH：a4p 写 req 文件 → dsh web 进程内插件 agent.followup 注入会话
           → whenIdle 等待轮次结束 → 提取回复写 resp 文件 → a4p 轮询取回
  → 或 claude --resume <会话> --continue -p（headless，stdin 作为消息）
  → 或 codex exec resume <会话> -o <临时文件> -（Codex，-o 捕获最后一条回复）
  → AI 回复写入会话并回推手机
  →（DSH 续聊直接发生在桌面正在运行的会话上，手机与桌面看到同一段对话）
  →（Codex 会话被窗口占用时自动 fork 新线程续聊，无需关闭原窗口）
```

### Hook 输出格式

- 提问（PreToolUse）：Claude Code 为 `hookEventName: "PreToolUse"` + `permissionDecision: "allow"` + `updatedInput.answers`（改写工具输入）；Codex 为 `permissionDecision: "deny"` + `permissionDecisionReason` 写入手机答案（阻断 `request_user_input` 调用，让模型直接采用答案继续）
- 权限请求（PermissionRequest）：`hookEventName: "PermissionRequest"` + `decision.behavior`

## 注意事项

- 需 Node.js 18+，手机端安装 ntfy App
- 手机订阅后，请在**订阅设置**中开启"即时交付"，否则消息需手动刷新才能收到
- 续聊支持 DSH、Claude Code 与 Codex 会话（按最近会话的 agent 自动选择方式）；DSH 续聊需 `dsh web` 正在运行且已挂载新版插件；Codex 续聊通过 `codex exec resume` 执行，需 Codex CLI 已登录、hook 已信任
- DSH 支持任务完成通知 / 提问作答 / 权限审批 / 远程续聊（经内置 `dsh-hook` 插件）
- 续聊期间守护进程会自动临时切换为外出模式，结束后恢复原模式
- Claude Code 会话同一时间只能被一个进程占用，`--resume` 续聊前请先结束终端里仍在运行的原会话；Codex 会话被占用时 a4phone 会自动 fork 新线程续聊（复制会话为新线程 ID，原窗口不受影响，手机对话在 fork 上继续）
- 续聊守护进程默认随 `a4p setup` 启动并注册**开机自启**（Windows 登录时自动运行）；也可手动 `a4p listen`，WSL/Linux 可用 tmux 或 systemd
- **ntfy.sh 免费托管服务有发布速率/消息保留限制**：短时间高频测试可能触发 `limited` 提示，建议降低推送频率（续聊结果已去重推送，不再重复通知）
- ntfy.sh 公共话题可被知晓话题名的人读写，重要场景建议自建 ntfy 服务或使用访问令牌
- ntfy.sh 为国外服务，国内网络下长连接可能不稳定
- **自动更新提醒**：默认开启（`checkUpdates: true`）。守护进程（`a4p listen`）启动时及每 `updateIntervalHours` 小时（默认 6）检查一次 npm registry（npmmirror 优先、官方兜底），发现新版本**推送手机提醒**；其他命令（`a4p status`/`a4p resume` 等）发现新版本时**终端提示 + 手机推送**（与守护进程共用去重缓存，同一版本只提醒一次）。查询失败静默跳过，不影响正常功能；可在 `~/.a4phone/config.json` 设 `checkUpdates: false` 关闭
- 配置存储于 `~/.a4phone/config.json`，最近会话存储于 `~/.a4phone/last.json`，模式存储于 `~/.a4phone/mode.json`，守护进程信息存储于 `~/.a4phone/daemon.json`，日志写入 `~/.a4phone/daemon.log`；DSH Hook 日志写入 `~/.a4phone/dsh-logs/`，DSH 续聊队列位于 `~/.a4phone/dsh-jobs/`，心跳位于 `~/.a4phone/dsh-heartbeat.json`，更新检查缓存位于 `~/.a4phone/update-cache.json`

## 开发

```bash
npm install              # 安装依赖
node bin/a4p.mjs setup   # 本地调试
```

## 开源协议

[MIT](LICENSE)
