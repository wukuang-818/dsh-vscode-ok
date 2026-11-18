# Changelog

## 0.4.1

- The loopback proxy now refreshes the auth cookie and replays the request when the backend answers 401, so the embedded interface recovers after the session cookie expires.
- The status tree reports the port the backend actually printed, not the configured one.

## 0.4.0

- Added a loopback reverse proxy. A webview iframe is a third-party context and drops the backend's `Set-Cookie`, so the extension keeps the auth cookie itself and injects it into forwarded requests.
- Forwarded WebSocket upgrades and returned 502 diagnostics when the backend is unreachable.

## 0.3.3, 0.3.2, 0.3.1

- Iterative fixes while the embedded front end replaced the hand-written chat UI.

## 0.3.0

- Replaced the custom chat UI with the official DSH web front end. The extension starts `dsh web` and loads it in the editor, so plan mode, tasks, background jobs, workflows, subagents, skills, MCP, the plugin marketplace, session compaction, the terminal sidebar, traces and usage all match the desktop client.

## 0.2.0 (unreleased)

Chat UI rebuilt to match the mainstream coding agents while keeping DSH as the agent core, plus new interaction, capability and performance work.

- New transcript: session title bar with overflow actions, empty state with suggestions, right-aligned user bubbles, assistant role line, collapsible reasoning with duration, markdown with code-fence copy and table wrapper, compact tool rows with inline diffs, child-session links and expandable input/output.
- Inline approval card at the end of the transcript (allow once / always allow this tool / skip) with keyboard focus; approvals still answered over `/api/$events/result`.
- Composer rebuilt: context menu for files, selection and problems, attachment chips with image thumbnails, send/stop button, focus ring, toasts in flow.
- Slash-command menu with local actions and the runtime's own `commands/list` commands executed through `commands/execute`.
- `@` mentions with workspace file autocomplete; mentions are attached as editor context.
- Image paste and drag-and-drop, sent as `image` content blocks.
- Plan panel driven by the runtime's `todo` events, and a token/context usage footer.
- Session picker: local filter, runtime session search, rename and fork.
- Reasoning-effort pill in the composer.
- Performance: host batches high-frequency stream messages per frame, markdown rendering is memoized, transcripts render in a sliding window without dropping or reordering events.
- Capability plumbing added to the transport: `session/rename`, `session/fork`, `session/search`, `skills/list`, `commands/list`, `commands/execute`, image prompt blocks.

## 0.1.0 (unreleased)

First release.

- Chat sidebar (secondary sidebar with activity bar fallback) with streaming text, reasoning, tool calls and todo lists.
- Approval cards wired to the runtime's approval requests, with option labels supplied by the runtime.
- Session create, list and switch; session title, model, token usage and context pressure from projections.
- Model and agent preset pickers backed by the runtime catalog; permission preset and reasoning effort selection.
- File diffs from tool results open in the diff editor; patch-only results render as a diff document.
- Editor context attachments: selection, active file, workspace diagnostics and terminal output.
- `@dsh` chat participant with `/new`, `/status`, `/model`, `/permission`, `/agent`, `/sessions` and `/compact`.
- Runtime discovery across `dsh` on `PATH`, a desktop install, the npm global shim and `npx`.
- Token/cookie handling for the spawned `dsh web` server, with free-port fallback when the configured port is occupied.
- Status bar entry and `dsh-vscode-ok` output channel.
- Project, package and display name are `dsh-vscode-ok`; the extension is independent and not affiliated with DeepSeek.
