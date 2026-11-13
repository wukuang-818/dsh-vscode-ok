# dsh-vscode-ok

dsh-vscode-ok is an independent, open-source coding agent for Visual Studio Code. It drives the open-source DSH (DeepSeek Harness) runtime and puts a streaming chat agent in the sidebar: tool calls, workspace edits, approvals, sessions, models and permission presets. The chat runs through the DSH runtime instead of Copilot's agent.

This project is not affiliated with, endorsed by, or sponsored by DeepSeek. The names "DeepSeek", "DeepSeek Harness" and "DSH" are used only to describe compatibility with that runtime, and all rights to those names and marks belong to their owners. The extension ships no DeepSeek logo or brand asset.

The extension does not reimplement the agent. It launches a local `dsh web` runtime and talks to it over the documented-by-observation HTTP + WebSocket protocol: token exchange, JSON-RPC over `/api/*`, and the remote mux stream at `/api/remote.mux`. Everything in the UI is produced by the real runtime with your own `~/.dsh` profile, models and credentials.

![dsh-vscode-ok chat sidebar with a streaming answer, tool call and approval dialog](media/screenshot-chat.png)


## Features

- Chat sidebar in the secondary sidebar (activity bar fallback on older VS Code), Preact UI rendered with VS Code theme variables.
- Streaming assistant text, reasoning, tool calls, todo lists and notices, mapped from the runtime session event stream.
- Approvals: tool calls that need permission surface as an approval card with the options the runtime advertises, answered back over `/api/$events/result`.
- Sessions: create, list, switch; title, model, token usage and context pressure from session projections.
- Models and agent presets picked from the runtime catalog (`session/modelCatalog`, `agentPresets/list`).
- Permissions preset selection (`read-only`, `workspace-write`, `danger-full-access`) and reasoning effort.
- Workspace edits: file diffs from tool results open in the diff editor, with a patch fallback when only the patch text is available.
- Editor context: send the selection, the active file, workspace diagnostics or terminal output to the agent as attachments.
- Native Chat view integration: `@dsh` chat participant with `/new`, `/status`, `/model`, `/permission`, `/agent`, `/sessions`, `/compact` slash commands, so the agent is also reachable from the standard chat UI.
- Status bar entry with backend state, session, model and permission; output channel `dsh-vscode-ok` for transport logs.
- Runtime discovery: `dsh` on `PATH`, a DSH desktop install (via the Windows uninstall registry), an npm global shim, or `npx`, plus explicit overrides.

## Requirements

- VS Code 1.96 or newer (1.106 or newer for the secondary sidebar placement).
- A DSH runtime installed, either the desktop app or `dsh` on `PATH` (`npm i -g @deepseek-ai/dsh`).
- Model credentials configured in the DSH profile (`~/.dsh`), since the runtime performs the model calls.

## Getting started

1. Install the extension from the VSIX or from GitHub Releases.
2. Open a folder. The extension auto-starts the runtime on first activation unless `dsh.autoStart` is `false`.
3. Open the dsh-vscode-ok view in the secondary sidebar (or press `Ctrl+Alt+D`) and type a prompt.
4. The first launch takes a few seconds while the runtime boots and connects.

The extension always drives a runtime it started itself: the launch token is printed on the child process's stdout and never exposed elsewhere, so a server started by the desktop app or by another extension cannot be adopted. When the configured port is already occupied and `dsh.reuseExisting` is `true`, the extension picks a free port and starts there instead of failing. The launch token is exchanged for a peer cookie through `/connect?token=...`, and that cookie is kept in memory for the session.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `dsh.executable` | `""` | Explicit path to the `dsh` CLI. Empty means auto-detect. |
| `dsh.executableArgs` | `[]` | Arguments placed before the transport arguments. |
| `dsh.host` | `127.0.0.1` | Host the runtime listens on. |
| `dsh.port` | `3080` | Port the runtime listens on. |
| `dsh.reuseExisting` | `true` | Pick a free port when `dsh.port` is already occupied. |
| `dsh.autoStart` | `true` | Start the runtime on activation. |
| `dsh.profile` | `""` | DSH profile passed as `--profile`; empty uses `web`. |
| `dsh.dshHome` | `""` | `DSH_HOME` override; empty uses `~/.dsh`. |
| `dsh.model` | `""` | Preferred model (`provider:model`). |
| `dsh.permissionPreset` | `workspace-write` | Default permission preset. |
| `dsh.agentPreset` | `""` | Preferred agent preset id. |
| `dsh.effort` | `""` | Reasoning effort for the selected model. |
| `dsh.startTimeoutMs` | `120000` | Time allowed for the runtime to become ready. |
| `dsh.commandTimeoutMs` | `600000` | Time allowed for a single agent turn. |
| `dsh.confirmBeforeSend` | `true` | Stage editor context in the composer before sending. |
| `dsh.includeEditorContext` | `true` | Attach the active file when sending from commands. |
| `dsh.includeDiagnostics` | `true` | Allow sending workspace diagnostics. |
| `dsh.debug` | `false` | Verbose transport logging. |

## Commands

`dsh-vscode-ok: New Chat`, `dsh-vscode-ok: Focus Chat`, `dsh-vscode-ok: Start Backend`, `dsh-vscode-ok: Restart Backend`, `dsh-vscode-ok: Stop Backend`, `dsh-vscode-ok: Show Logs`, `dsh-vscode-ok: Pick Model`, `dsh-vscode-ok: Pick Permission Preset`, `dsh-vscode-ok: Pick Agent Preset`, `dsh-vscode-ok: Send Selection`, `dsh-vscode-ok: Send File`, `dsh-vscode-ok: Add File to Chat`, `dsh-vscode-ok: Attach Problems`, `dsh-vscode-ok: Copy Session ID`, `dsh-vscode-ok: Open Settings`.

Editor and Explorer context menus expose send/add-to-chat for the selected file.

## Architecture

```
VS Code extension host                       DSH runtime (spawned by the extension)
┌──────────────────────────────┐            ┌───────────────────────────────┐
│ chat webview (Preact)        │            │ dsh web server                │
│   ↕ postMessage              │            │   /api/<ns>/<method>  (HTTP)  │
│ ChatController               │  JSON-RPC  │   /api/remote.mux     (WS)    │
│   ↕ AgentEvent               │ ─────────► │   session/follow              │
│ WebBackend (transport)       │            │   $events (approvals, lists)  │
│ ChatViewProvider / commands  │ ◄───────── │   session events              │
└──────────────────────────────┘            └───────────────────────────────┘
```

- `src/dsh/webClient.ts` owns process lifecycle, token/cookie auth, the RPC envelope and the multiplexed streams.
- `src/dsh/webBackend.ts` translates wire events into the transport-independent `AgentEvent` union.
- `src/chat/controller.ts` maintains chat state and is the single writer for the webview and the chat participant.
- `src/webview/` is the Preact UI; the host and webview only exchange the messages in `src/shared/protocol.ts`.

### Why the web protocol and not the SDK or ACP

The DSH runtime ships three machine-facing entry points:

- `dsh --profile sdk` (JSON-RPC over stdio via `@deepseek-ai/dsh-sdk-client`) is the cleanest API, but its public protocol has no live token streaming (one message per step), no cancel request (abort means killing the runtime) and no server-to-client approval channel in the published package. A chat UI of this class needs all three.
- `dsh --profile acp` (Agent Client Protocol) is designed for automation: it emits committed messages only, no token streaming, no tool or reasoning visibility, no session list or resume.
- `dsh web` exposes the protocol the official web UI itself uses: streaming assistant attempts, tool calls and results, approvals with answer routing, session list/create/fork, model catalogs, agent presets, settings and credentials.

The cost of that choice is version coupling: endpoint names changed between the 0.1 line (dotted names, `/api/events.mux`) and 0.2 (slash names, `/api/remote.mux`), and the transport has to speak each endpoint's exact argument names. The extension targets the 0.2 protocol and reports a clear notice when a server it finds does not match.

### Relation to existing extensions

- The Codex extension is a UX reference for sidebar placement and chat layout, but it registers a proposed `chatSessions` provider that marketplace builds cannot ship, so this extension uses the stable chat participant API plus a webview view.
- Other MIT-licensed DSH extensions were studied for their spawn, auth and streaming behaviour. No source code or asset from them is copied; the protocol facts here were re-derived by observing the runtime's own traffic.
- `deepseek-ai/dsh-superagent-prototype` is a DSH plugin bundle, not a VS Code extension and not a client for this protocol, so it is not the code base for this project.

## Development

```bash
npm install
npm run build        # esbuild host + webview bundles
npm run typecheck    # host + webview TypeScript
npm test             # vitest unit tests
npm run test:e2e     # activation smoke: stubbed vscode host + real dsh web runtime
```

`test:e2e` loads the built extension, registers the view, sends a real prompt through
a freshly spawned `dsh web` runtime and asserts the streamed reply. It needs a working
DSH installation and credentials; the runtime is stopped again when the test finishes.

Run the extension locally with the `Run dsh-vscode-ok Extension` launch configuration, or:

```bash
code --extensionDevelopmentPath="D:\WK_file\dsh-vscode-ok" --disable-extensions --profile-temp --log=trace
```

Package a VSIX with `npm run package`.

Reconnaissance notes that document the observed protocols live in `docs/recon/` (`vscode-api.md`, `dsh-web-api.md`, `ref-impl.md`, `dsh-sdk.md`). They are research notes, not shipped code.

## Naming, licensing and notices

- The project, the package name and the display name are `dsh-vscode-ok`. It is an independent project, not a DeepSeek product, and it is not called "DSH": that name is used only to describe the runtime it connects to.
- License: MIT, see `LICENSE`.
- No code, icons, screenshots, strings or other assets from proprietary extensions are included. Protocol constants and endpoint names are factual interface identifiers needed for interoperability.
- Icons and screenshots under `media/` were created for this project.
