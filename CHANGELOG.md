# Changelog

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
