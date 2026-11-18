# dsh-vscode-ok

Bring DeepSeek Harness into VS Code. Since 0.3.0 the extension no longer ships a hand-written chat front end. It starts the local `dsh web` backend and loads the official DSH web interface inside the editor.

## Why the implementation changed

0.2.0 talked to the runtime through an undocumented HTTP and WebSocket protocol and could only reproduce a small part of the chat surface. The official front end is made of hundreds of modules: plan mode, tasks, background jobs, workflows, subagents, skills, MCP, the plugin marketplace, session compaction, the terminal sidebar, traces and usage all live there, and rebuilding them one by one was not practical.

From 0.3.0 the extension loads the whole front end instead, so the capabilities match the desktop client. Anything you can do in the desktop app is available here.

## Usage

| Command | Keybinding | Description |
|---|---|---|
| `dsh-vscode-ok: Open UI` | `Ctrl+Alt+D` | Starts the backend if needed, then opens the interface. |
| `dsh-vscode-ok: Restart Backend` | - | Kills and relaunches the process; the token is renewed. |
| `dsh-vscode-ok: Stop Backend` | - | Stops the process manually. |
| `dsh-vscode-ok: Open in External Browser` | - | Opens the token-bearing address in the system browser. |
| `dsh-vscode-ok: Copy Access URL` | - | Copies the address to the clipboard. |
| `dsh-vscode-ok: Show Logs` | - | Opens the output channel with the full startup log. |

The `dsh-vscode-ok` icon in the secondary sidebar opens a small status tree: runtime state, listening port, open UI, external browser, copy address and logs. Clicking the icon does not open the interface by itself; only the open command or `Ctrl+Alt+D` does.

## Configuration

| Key | Default | Description |
|---|---|---|
| `dsh.port` | `3081` | Backend port. The desktop app uses 3080 by default, so the extension stays clear of it. |
| `dsh.autoPort` | `true` | When the configured port is busy, scan upward for a free one. |
| `dsh.executable` | empty | Full path to `dsh.cmd`. Empty means auto-detect from the desktop install directory and `PATH`. |
| `dsh.executableArgs` | `[]` | Extra arguments passed before the `web` subcommand. |
| `dsh.dshHome` | empty | Overrides `DSH_HOME`; defaults to `~/.dsh`. |
| `dsh.startTimeoutMs` | `120000` | How long to wait for the backend readiness line. |
| `dsh.useEditorTab` | `true` | Use the built-in Simple Browser; turn it off to fall back to a self-built webview panel. |
| `dsh.placement` | `sidebar` | Default landing spot for the open command: `sidebar` or `editor`. |

## Known limitations

Theme does not follow VS Code. The official interface ships its own dark theme and does not consume the `--vscode-*` variables; that is the cost of embedding the official front end.

`~/.dsh` is shared with the desktop app. Sessions, credentials and plugins are the same files. Sending to one session from both sides at the same time can conflict, so use one side at a time.

The token changes on every start. After a restart the old address stops working; open the interface again from the command instead of reusing the URL.

## Migrating from 0.2.0

The `@dsh` chat participant and its seven slash commands are gone; those capabilities live in the official interface. The old settings `dsh.model`, `dsh.permissionPreset`, `dsh.agentPreset`, `dsh.effort`, `dsh.confirmBeforeSend`, `dsh.includeEditorContext`, `dsh.includeDiagnostics`, `dsh.debug`, `dsh.reuseExisting`, `dsh.profile` and `dsh.host` are no longer read and will be flagged as unknown in `settings.json`.

The default of `dsh.port` moved from 3080 to 3081. If you pinned 3080, switch to 3081 or remove the entry.
