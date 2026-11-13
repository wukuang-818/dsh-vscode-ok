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
- Runtime discovery across `dsh` on `PATH`, the desktop install, the npm global shim and `npx`, plus token/cookie handling for reusing a running `dsh web` server.
- Status bar entry and `DSH` output channel.
