# Reconnaissance notes

These documents record how the DSH runtime and the VS Code chat APIs behave, gathered
while building `dsh-vscode-ok`. They are research notes kept for maintenance, not shipped
code and not part of the extension bundle.

- `vscode-api.md`: stable vs proposed chat APIs in VS Code 1.146, and the placement
  strategy used by this extension.
- `dsh-web-api.md`: the `dsh web` HTTP + WebSocket surface, captured from a running
  runtime and cross-checked against the public API descriptors.
- `ref-impl.md`: behaviour of other DSH-related VS Code extensions, used as a feature
  checklist for spawn, auth, streaming and cleanup semantics.
- `dsh-sdk.md`: the `dsh --profile sdk` stdio protocol and its limits.

Method and licensing: the facts were derived by observing runtime traffic, reading public
npm package contents and public API descriptors, and reading installed MIT-licensed
extensions. No source code, assets, icons or user-facing strings from other extensions are
copied into this repository. Third-party names appear only as factual references.
