# dsh-vscode-ok

把 DeepSeek Harness 接进 VS Code。0.3.0 起换了实现方式：不再重写一套聊天界面，直接启动本地 `dsh web` 后端，把官方 Web 界面嵌进编辑器。

## 为什么换

0.2.0 走的是逆向出来的 HTTP 与 WebSocket 协议，只能覆盖聊天主干的一小部分。官方前端由上百个模块组成，计划模式、目标、后台任务、工作流、子代理、技能、MCP、插件市场、会话压缩、终端侧栏、轨迹与统计都在里面，逐个补齐不现实。

0.3.0 把整块前端搬进来，能力与桌面客户端完全一致：你在桌面版里能看到的功能，这里都有。

## 用法

| 命令 | 快捷键 | 说明 |
|---|---|---|
| `dsh-vscode-ok: 打开界面` | `Ctrl+Alt+D` | 后端没起就先起，起了直接打开 |
| `dsh-vscode-ok: Restart Backend` | — | 杀掉进程重新拉，token 会刷新 |
| `dsh-vscode-ok: Stop Backend` | — | 手动回收进程 |
| `dsh-vscode-ok: Open in External Browser` | — | 用系统浏览器打开，含 token 的地址 |
| `dsh-vscode-ok: Copy Access URL` | — | 复制地址到剪贴板 |
| `dsh-vscode-ok: Show Logs` | — | 打开输出通道，看启动全过程 |

侧边栏的 `dsh-vscode-ok` 图标保留，里面是一张运行时状态表：运行状态、监听地址、打开界面、外部浏览器、复制地址、查看日志。点图标时不自动弹界面，只在你点「打开界面」或按 `Ctrl+Alt+D` 时打开。

## 配置

| 键 | 默认值 | 说明 |
|---|---|---|
| `dsh.port` | `3081` | 后端端口。桌面版默认占 3080，这里错开 |
| `dsh.autoPort` | `true` | 端口被占时自动往后找空闲的 |
| `dsh.executable` | 空 | `dsh.cmd` 路径。空则自动找桌面版安装目录与 PATH |
| `dsh.executableArgs` | `[]` | 在 `web` 之前追加的参数 |
| `dsh.dshHome` | 空 | 覆盖 `DSH_HOME`，默认用 `~/.dsh` |
| `dsh.startTimeoutMs` | `120000` | 等待后端就绪的超时 |
| `dsh.useEditorTab` | `true` | 用内置 Simple Browser；关掉则退回自建 webview 面板 |

## 三个已知限制

**主题不跟随。** 官方界面自带暗色主题，不使用 VS Code 的 `--vscode-*` 变量。这是嵌入官方前端换来的代价。

**与桌面版共享 `~/.dsh`。** 会话、凭据、插件都是同一份。两边同时往一个会话发消息会有写冲突，建议同一时间只用一边。

**token 每次启动都变。** 重启后旧地址失效，用命令重新打开即可，不需要手动复制。

## 从 0.2.0 迁移

`@dsh` chat participant 与它带的七个斜杠命令去掉了，那些能力在官方界面里都有。旧配置项 `dsh.model`、`dsh.permissionPreset`、`dsh.agentPreset`、`dsh.effort`、`dsh.confirmBeforeSend`、`dsh.includeEditorContext`、`dsh.includeDiagnostics`、`dsh.debug`、`dsh.reuseExisting`、`dsh.profile`、`dsh.host` 不再使用，留在 `settings.json` 里会被标为未知配置，可以删掉。

`dsh.port` 的默认值从 3080 改成了 3081。如果你之前显式写过 3080，建议改成 3081 或删掉这一项。
