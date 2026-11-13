# VS Code 1.146 chat / agent extension API recon

Recon for a VS Code extension that replaces the built-in Copilot agent surface with the DeepSeek Harness (DSH) agent, packaged with `vsce` for VS Code 1.146 stable, ideally without proposed APIs.

## 0. Evidence base

- VS Code 1.146.0 stable, install root `C:\Users\aaa_w\AppData\Local\Programs\Microsoft VS Code\69047191fc` (per-build hash directory; `resources\app` lives under it, not under `Microsoft VS Code\resources\app`). Confirmed via `<hash>\resources\app\package.json` (`name: "Code"`, `version: "1.146.0"`).
- Stable typings: `<hash>\resources\app\out\vscode-dts\vscode.d.ts` (775,182 bytes, 21,506 lines). It is the only file in that directory, so the stable distribution ships no `vscode.proposed.*.d.ts`. Line numbers below refer to this file.
- Workbench bundle: `<hash>\resources\app\out\vs\workbench\workbench.desktop.main.js` (contribution points, menus, harness settings).
- Extension host bundle: `<hash>\resources\app\out\vs\workbench\api\node\extensionHostProcess.js` (the `vscode` API facade and proposal gates).
- CLI: `<hash>\resources\app\out\cli.js` (accepted command line flags).
- Reference extension: OpenAI Codex `C:\Users\aaa_w\.vscode\extensions\openai.chatgpt-26.1111.21308-win32-x64` (`package.json` 7,401 B, `out/extension.js` 2,542,712 B minified, no sourcemap, React webview app under `webview/`).
- Minified identifier names in the bundles (`LJr`, `vL`, `Av`, ...) are build-specific; the quoted strings (`extensionPoint:`, proposal names, command ids, URIs) are stable and greppable.
- Docs used (fetched 2026-11-13):
  - https://code.visualstudio.com/api/extension-guides/ai/chat.md (chat participants, deprecation notice dated 11/11/2026)
  - https://code.visualstudio.com/api/advanced-topics/using-proposed-api.md
  - https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider.md
  - https://code.visualstudio.com/api/working-with-extensions/testing-extension.md
  - https://raw.githubusercontent.com/microsoft/vscode/main/src/vscode-dts/vscode.proposed.chatSessionsProvider.d.ts
  - https://raw.githubusercontent.com/microsoft/vscode/main/src/vscode-dts/vscode.proposed.chatParticipantAdditions.d.ts
  - https://raw.githubusercontent.com/microsoft/vscode-vsce/main/src/publish.ts (proposed API publish gate)

## 1. The `chatSessions` contribution in 1.146: proposed API, not available to a normal third-party extension

### 1.1 What registers it

`contributes.chatSessions` is a real contribution point in the 1.146 workbench, registered as:

```js
registerExtensionPoint({
  extensionPoint: "chatSessions",
  jsonSchema: {
    type: "array",
    items: {
      type: "object", additionalProperties: false,
      required: ["type", "name", "displayName", "description"],
      properties: {
        type: { type: "string" },                 // must match the id used at runtime
        name: { type: "string", pattern: "^[\\w-]+$" },
        displayName: { type: "string" },
        description: { type: "string" },
        when: { type: "string" },
        icon: { anyOf: [{ type: "string" }, { type: "object", properties: { light, dark } }] },
        order: { type: "integer" },
        alternativeIds: { type: "array", items: { type: "string" } },
        welcomeTitle, welcomeMessage, welcomeTips, inputPlaceholder: { type: "string" },
        capabilities: { type: "object", additionalProperties: false, properties: {
          supportsFileAttachments, supportsToolAttachments, supportsMCPAttachments, supportsImageAttachments,
          supportsSearchResultAttachments, supportsInstructionAttachments, supportsSourceControlAttachments,
          supportsProblemAttachments, supportsSymbolAttachments, supportsPromptAttachments, supportsHandOffs: { type: "boolean" } } },
        commands: { type: "array", items: { type: "object", required: ["name"], properties: { name, description, when } } },
        canDelegate: { type: "boolean", default: false },
        customAgentTarget: { type: "string" },
        requiresCustomModels: { type: "boolean", default: false },
        supportsAutoModel: { type: "boolean", default: false },
        requiresCopilotSignIn: { type: "boolean", default: false },
        autoAttachReferences: { type: "boolean", default: false },
        useRequestToPopulateBuiltInPickers: { type: "boolean", default: false }
      }
    }
  },
  activationEventsGenerator: function* (s) { for (const o of s) yield `onChatSession:${o.type}`; }
});
```

There is no `locations` property in this schema. `locations` exists only on `contributes.chatParticipants` (proposal-gated there, see section 2). A manifest that adds `locations` under `chatSessions` fails schema validation (`additionalProperties: false`).

The runtime API that pairs with the contribution lives in the proposed file `vscode.proposed.chatSessionsProvider.d.ts`:

- `chat.registerChatSessionItemProvider(chatSessionType: string, provider: ChatSessionItemProvider): Disposable` — "To use this, also make sure to also add `chatSessions` contribution in the package.json".
- `chat.createChatSessionItemController(chatSessionType, refreshHandler): ChatSessionItemController`
- `chat.registerChatSessionContentProvider(scheme, provider: ChatSessionContentProvider, defaultChatParticipant: ChatParticipant, capabilities?: ChatSessionCapabilities): Disposable`
- Types: `enum ChatSessionStatus { Failed = 0, Completed = 1, InProgress = 2, NeedsInput = 3 }`, `ChatSessionItem { resource, label, iconPath?, description?, badge?, status?, tooltip?, archived?, legacyResource?, timing?: { created, lastRequestStarted?, lastRequestEnded?, startTime?, endTime? }, changes?: ChatSessionChangedFile[], metadata? }`, `ChatSession { title?, history: ReadonlyArray<ChatRequestTurn | ChatResponseTurn2>, options?, activeResponseCallback?, requestHandler: ChatRequestHandler | undefined, forkHandler? }`, `ChatSessionContentProvider { provideChatSessionContent(resource, token, context: { inputState }): ... }`, `ChatContext.chatSessionContext?: ChatSessionContext`, option groups (`ChatSessionProviderOptionGroup`, `ChatSessionProviderOptionItem`, `ChatSessionInputState`).

### 1.2 It is gated at runtime by the `chatSessionsProvider` proposal

Every entry point in the `vscode.chat` facade starts with a proposal gate (extensionHostProcess.js):

```js
function Qe(r,t){return r.enabledApiProposals?r.enabledApiProposals.includes(t):!1}
function M(r,t){if(!Qe(r,t))throw new Error(`Extension '${r.identifier.value}' CANNOT use API proposal: ${t}. Its package.json#enabledApiProposals-property declares: ${r.enabledApiProposals?.join(", ")??"[]"} but NOT ${t}.`)}
```

- `registerChatSessionItemProvider` → `M(P, "chatSessionsProvider")` plus `f.report("chat.registerChatSessionItemProvider", P, "Please migrate to the new chat session controller API", { usageId: S })`
- `createChatSessionItemController` → `M(P, "chatSessionsProvider")`
- `registerChatSessionContentProvider` → `M(P, "chatSessionsProvider")`
- `registerChatOutputRenderer` → `M(P, "chatOutputRenderer")`
- `registerChatWorkspaceContextProvider` / `registerChatAttachContextProvider` / `registerChatTabContextProvider` → `M(P, "chatContextProvider")`
- `createDynamicChatParticipant` → `M(P, "chatParticipantPrivate")`
- `registerCustomAgentProvider` → `M(P, "chatPromptFiles")`
- `createChatParticipant` has no gate: it is stable.

The contribution itself is also filtered, so a non-allowlisted extension is not even wired up:

```js
LJr.setHandler(h => { for (const g of h)
  if (ml(g.description, "chatSessionsProvider") && Array.isArray(g.value))
    this._register(this.registerContribution(f, g.description)); });
```

`ml(description, proposalName)` is the workbench-side "is this extension allowed this proposal" check. Consequences when it is false: the contribution is silently dropped (no user-visible error, only a log line), and the sessions UI never appears. The `agentSessions` views container is gated the same way: `if (a === "agentSessions" && !ml(i.description, "chatSessionsProvider")) { warn; skip }`. The session-related menu ids are gated too: `chatSessions/newSession`, `chatSessions/item/context`, `chat/chatSessions`, `chat/input/editing/sessionToolbar`, `chat/input/editing/sessionTitleToolbar` (all `proposed: "chatSessionsProvider"`).

### 1.3 Why Codex can do it and a third-party extension cannot

Codex `package.json`:

```json
"enabledApiProposals": ["chatSessionsProvider", "languageModelProxy"],
"contributes": {
  "chatSessions": [{ "type": "openai-codex", "name": "Codex",
    "displayName": "OpenAI Codex", "description": "OpenAI Codex integration for VS Code" }]
}
```

Codex registers the item provider at activation and wraps it in try/catch precisely because the proposal can be absent:

```js
function kZt(t,e,r,n,o){try{let i=new vL(t,e,r,n);return o.push(i),o.push(Et.chat.registerChatSessionItemProvider(Av,i)),i}
  catch(i){return he().info("Codex chat session item provider not registered",{safe:{},sensitive:{error:i}}),null}}
```

`Av` is the string `"openai-codex"`, matching the contribution `type` and the `customEditors` selector `openai-codex:/**/*`.

The proposal is granted to Codex by `product.json`, not by the extension alone. In 1.146 the proposal gate is implemented in the workbench (`Wbt` class):

```js
this._envEnabledExtensions = new Set((e.extensionEnabledProposedApi ?? []).map(i => Si.toKey(i)));
this._envEnablesProposedApiForAll =
  !e.isBuilt ||
  e.isExtensionDevelopment && t.quality !== "stable" ||
  this._envEnabledExtensions.size === 0 && Array.isArray(e.extensionEnabledProposedApi);
```

and per extension:

```js
// id listed in product.json#extensionEnabledApiProposals -> product.json WINS (may log "enables LESS API proposals than the extension wants")
o.enabledApiProposals = productList;
// otherwise
this._envEnablesProposedApiForAll || this._envEnabledExtensions.has(e)
  || !o.isBuiltin && js(o.enabledApiProposals)
     && (log.error("Extension '...' CANNOT USE these API proposals '...'. You MUST start in extension development mode or use the --enable-proposed-api command line flag"),
         o.enabledApiProposals = []);
```

`product.json` (duplicated in `out/mainImpl.js` and `out/vs/code/electron-utility/sharedProcess/sharedProcessMain.js`) contains:

```
"extensionEnabledApiProposals": { ... "openai.chatgpt": ["languageModelProxy", "chatSessionsProvider"],
  "GitHub.copilot-chat": [..., "chatSessionsProvider"], "GitHub.vscode-pull-request-github": [..., "chatSessionsProvider"] }
"extensionsEnabledWithApiProposalVersion": ["GitHub.copilot-chat", "ms-vscode.vscode-commander",
  "ms-vscode.vscode-copilot-vision", "GitHub.vscode-pull-request-github"]
```

A new publisher id is not in that list, so on a default stable install the declared proposals are stripped before the extension host starts, and `M()` throws on first use.

### 1.4 Verdict and risk

- Verdict: `contributes.chatSessions` + `chat.registerChatSessionItemProvider` is proposed-only in 1.146. A third-party extension can use it only if VS Code is started with `--enable-proposed-api=<publisher.name>` (per-id, the flag is `type: "string[]", allowEmptyValue: true` in `cli.js`; bare `--enable-proposed-api` sets `extensionEnabledProposedApi = []`, which enables proposals for every extension), or via `argv.json` `{ "enable-proposed-api": ["<publisher.name>"] }`. It is not usable from a plain Marketplace install.
- Exact proposal name: `chatSessionsProvider`. Proposal file: `vscode.proposed.chatSessionsProvider.d.ts` (URL in the workbench proposal registry points at the `main` branch, which means the API can change between releases with no compatibility promise).
- Distribution risk, verified: `vsce publish` refuses extensions that use proposals outside the Marketplace allowlist. From `vscode-vsce/src/publish.ts`:
  `if (manifest.enabledApiProposals && !options.allowAllProposedApis && !options.noVerify && manifest.enabledApiProposals?.some(p => !options.allowProposedApis?.includes(p))) throw new Error("Extensions using unallowed proposed API ... can't be published to the Marketplace. Use --allow-proposed-apis <APIS...> or --allow-all")`.
  `vsce package` still works, and the manifest records `<Property Id="Microsoft.VisualStudio.Code.EnabledApiProposals" .../>` in the `.vsixmanifest`.
- Official doc wording (using-proposed-api.md): proposed APIs "are subject to change, only available in Insiders distribution and should not be used in published extensions"; the supported sharing model is VSIX + relaunch with `--enable-proposed-api=<ext-id>`.
- Practical risk if you depend on it: silent feature loss (contribution dropped, no error surfaced to the user), hard requirement that the user edit `argv.json` or the shortcut, and possible breakage on any monthly release.

## 2. Stable Chat Participant API (`vscode.chat.createChatParticipant`)

### 2.1 Manifest contribution

`contributes.chatParticipants` is still registered in 1.146. Schema (workbench.desktop.main.js), `additionalProperties: false`, `required: ["name", "id"]`:

```json
"chatParticipants": [{
  "id": "dsh.agent",
  "name": "dsh",
  "fullName": "DeepSeek Harness",
  "description": "DSH agent for this workspace",
  "isSticky": true,
  "sampleRequest": "Explain this file",
  "commands": [{ "name": "fix", "description": "Fix the selected code" }]
}]
```

Properties in the published schema: `id`, `name` (`^[\w-]+$`), `fullName` (defaults to `name`), `description`, `isSticky`, `sampleRequest`, `when`, `disambiguation` (`[{ category, description, examples[] }]`), `commands` (`[{ name, description, when, sampleRequest, isSticky, disambiguation }]`). The extension point auto-generates the activation event `onChatParticipant:<id>`.

`isDefault`, `modes` and `locations` are read by the contribution handler but are not in the schema and are proposal-gated:

```js
if ((i.isDefault || i.modes) && !ml(t.description, "defaultChatParticipant"))
  collector.error(`Extension '...' CANNOT use API proposal: defaultChatParticipant.`);
if (i.locations && !ml(t.description, "chatParticipantAdditions"))
  collector.error(`Extension '...' CANNOT use API proposal: chatParticipantAdditions.`);
```

A plain participant is registered with `locations: ["panel"]`, `modes: ["agent", "ask", "edit"]`, and the declared slash commands. Do not declare `isDefault` / `modes` / `locations`.

### 2.2 Runtime API (stable)

`vscode.d.ts` L20383:

```ts
export namespace chat {
  export function createChatParticipant(id: string, handler: ChatRequestHandler): ChatParticipant;
}
```

This is the only member of the `chat` namespace in stable 1.146 typings. Notable stable surface:

- `ChatParticipant` (L20055): `id`, `iconPath?`, `requestHandler`, `followupProvider?`, `onDidReceiveFeedback: Event<ChatResultFeedback>`, `dispose()`.
- `ChatRequestHandler` (L20049): `(request: ChatRequest, context: ChatContext, response: ChatResponseStream, token: CancellationToken) => ProviderResult<ChatResult | void>`.
- `ChatContext` (L19938): `history: ReadonlyArray<ChatRequestTurn | ChatResponseTurn>`.
- `ChatRequest` (L20122): `prompt: string`, `command: string | undefined`, `references: readonly ChatPromptReference[]`, `toolReferences: readonly ChatLanguageModelToolReference[]`, `toolInvocationToken: ChatParticipantToolToken`, `model: LanguageModelChat`.
- `ChatResponseStream` (L20177): `markdown(value: string | MarkdownString)`, `anchor(value: Uri | Location, title?)`, `button(command: Command)`, `filetree(value, baseUri)`, `progress(value)`, `reference(value: Uri | Location, iconPath?)`, `push(part: ChatResponsePart)`.
- Stable part classes: `ChatResponseMarkdownPart` (L20244), `ChatResponseFileTreePart` (L20276), `ChatResponseAnchorPart` (L20298), `ChatResponseProgressPart` (L20320), `ChatResponseReferencePart` (L20336), `ChatResponseCommandButtonPart` (L20358, wraps a `vscode.Command`).
- `ChatFollowup` (L20009) / `ChatFollowupProvider` (L20035), `ChatPromptReference` (L20094) with `id`, `range?: [start, end]`, `modelDescription?`, `value: string | Uri | Location | unknown`.

Minimal participant:

```ts
const participant = vscode.chat.createChatParticipant('dsh.agent',
  async (request, context, stream, token) => {
    stream.progress('DSH is working');
    for await (const chunk of dshClient.stream({ prompt: request.prompt, refs: request.references }, token)) {
      if (chunk.type === 'text') stream.markdown(chunk.value);
      else if (chunk.type === 'file') stream.anchor(new vscode.Location(chunk.uri, chunk.range), chunk.title);
    }
    stream.button({ command: 'dsh.applyPendingEdit', title: 'Apply', arguments: [pendingEditId] });
  });
participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media/dsh.svg');
participant.followupProvider = {
  provideFollowups: () => [{ prompt: 'Continue', label: 'Continue' }, { prompt: 'Run the tests', label: 'Run tests' }]
};
```

### 2.3 Selection and file context

There is no `selection` field on `ChatRequest`. Context arrives as `request.references`, resolved by the Chat view when the user types `#file`, `#selection`, `#sym`, etc., or adjusts the implicit context. The workbench constructs implicit entries with fixed ids (workbench.desktop.main.js):

```js
q.add({ kind: "file", id: "vscode.implicit.selection", name: We(xt), value: { uri: xt, range: ht } })
```

so a participant sees the current editor selection as a `ChatPromptReference` with `id === "vscode.implicit.selection"` and `value === { uri, range }`, and the visible viewport as `vscode.implicit.viewport`. Additional editor context is supplied as more references (`#file`, `#codebase`, custom `#` variables resolved by VS Code). The participant must read and interpret `reference.value` itself.

### 2.4 Variables / reference resolution

- `chat.registerChatVariableResolver` does not exist in 1.146: zero occurrences in `vscode.d.ts`, zero in `extensionHostProcess.js` (the single `VariableResolver` hit there is the task/debug variable substitution service, unrelated). The old variable-resolver proposal is gone.
- The replacement is `ChatParticipant.participantVariableProvider?: { provider: ChatParticipantCompletionItemProvider; triggerCharacters: string[] }` plus `ChatCompletionItem(id, label, values: ChatVariableValue[])` and `enum ChatVariableLevel { Short = 1, Medium = 2, Full = 3 }` — all inside `vscode.proposed.chatParticipantAdditions.d.ts`, therefore proposed. Without it, a participant only gets the references VS Code resolves by itself.

### 2.5 Availability caveat: participants are deprecated and hidden by default

`https://code.visualstudio.com/api/extension-guides/ai/chat.md` states verbatim: "Chat participants are deprecated and are not supported in the Copilot harness. The Chat Participant API remains available for Local harness compatibility. Do not use it for new Copilot integrations." The replacement guidance is agent plugin packaging (skills + MCP server), MCP Apps for interactive UI, and extension tools for editor context.

The switch is visible in 1.146 settings (workbench.desktop.main.js, configuration id `chatAgentHost`):

- `chat.defaultToCopilotHarness`: boolean, default `true`
- `chat.editor.preferCopilotHarness`: boolean, default `true`, managed policy `ChatEditorPreferCopilotHarness`, minimumVersion 1.134
- `chat.temporaryDefaultToLocalHarness`: boolean, default `false`, policy `ChatTemporaryDefaultToLocalHarness`, minimumVersion 1.142
- `chat.editor.localAgent.enabled`: boolean, default `true`, tag `experimental`

Log strings nearby: "Local harness hidden, new chats use the Agent Host Copilot SDK". So a contributed participant only renders in the Local harness, which the user (or org policy) must select. Shipping a Copilot replacement as a participant means the user has to flip a harness setting, and the API is on a deprecation path.

## 3. Chat surface integration options

### 3.1 Secondary sidebar webview (stable)

`contributes.viewsContainers` accepts exactly three locations: `activitybar`, `panel`, `secondarySidebar` (workbench.desktop.main.js):

```js
switch (u) {
  case "activitybar": i = this.registerCustomViewContainers(p, l, i, e, 0); break;
  case "panel": n = this.registerCustomViewContainers(p, l, n, e, 1); break;
  case "secondarySidebar": r = this.registerCustomViewContainers(p, l, r, e, 2); break;
}
```

`contributes.views` supports `"type": "webview"`, and the runtime is `window.registerWebviewViewProvider(viewId, provider, { webviewOptions: { retainContextWhenHidden } })` (d.ts L11752) with `WebviewViewProvider.resolveWebviewView(webviewView, context, token)` (L10334) and `WebviewView` (L10225) exposing `viewType`, `webview`, `title`, `description`, `badge`, `show(preserveFocus?)`, `onDidChangeVisibility`.

Codex's manifest is the working reference for a chat product:

```json
"viewsContainers": {
  "activitybar": [{ "id": "codexViewContainer", "title": "Codex", "icon": "resources/blossom-white.svg",
    "when": "chatgpt.doesNotSupportSecondarySidebar" }],
  "secondarySidebar": [{ "id": "codexSecondaryViewContainer", "title": "Codex", "icon": "resources/blossom-white.svg",
    "when": "!chatgpt.doesNotSupportSecondarySidebar" }]
},
"views": {
  "codexViewContainer": [{ "id": "chatgpt.sidebarView", "type": "webview", "name": "Codex",
    "when": "chatgpt.doesNotSupportSecondarySidebar" }],
  "codexSecondaryViewContainer": [{ "id": "chatgpt.sidebarSecondaryView", "type": "webview", "name": "Codex",
    "when": "!chatgpt.doesNotSupportSecondarySidebar" }]
},
"customEditors": [{ "viewType": "chatgpt.conversationEditor", "displayName": "Codex Chat",
  "priority": "default", "selector": [{ "filenamePattern": "openai-codex:/**/*" }] }]
```

The context key is set at activation: `commands.executeCommand("setContext", <key>, !<versionSupportsSecondarySidebar>(vscode.version))`. Two distinct view ids are used because a container hidden by `when` does not re-home its views.

### 3.2 Custom editor for conversation tabs (stable)

`window.registerCustomEditorProvider(viewType, provider, { webviewOptions, supportsMultipleEditorsPerDocument })` (d.ts L11791), provider `CustomReadonlyEditorProvider` / `CustomTextEditorProvider` (L10358). Codex registers one for `openai-codex:/**/*` and renders the same webview inside it, so a session opens as an editor tab instead of / in addition to the sidebar. Fully stable, no proposals.

### 3.3 Native chat session provider (proposed)

With `chatSessionsProvider` granted, the extension contributes `chatSessions` (session list entry, input placeholder, capabilities, commands) and registers an item provider plus optionally a content provider. The native chat UI renders the conversation from `ChatSessionContentProvider.provideChatSessionContent(...)` returning `ChatSession { history, requestHandler }`. Codex registers only the item provider (`registerChatSessionItemProvider`) and renders conversation content in its own webview/custom editor; the custom editor selector `openai-codex:/**/*` matches the session resources produced by the item provider, so the native session list and the webview renderer are two halves of one product. (The exact click-through path is an inference from the registered pieces: item provider + custom editor selector + no content provider registration found in the bundle.)

### 3.4 Comparison

| Option | API status 1.146 | Native session list | Native input box / attachments | Rendering control | Distribution |
| --- | --- | --- | --- | --- | --- |
| (a) `chatSessions` + `registerChatSessionItemProvider` | proposed `chatSessionsProvider` | yes | yes (declared capabilities) | native or via content provider | blocked: needs `--enable-proposed-api`, `vsce publish` refuses |
| (b) `chatParticipants` + `createChatParticipant` | stable but deprecated, Local harness only | no (Chat view only) | yes | native markdown stream | publishable, but hidden by default harness |
| (c) secondarySidebar webview | stable | no | own implementation | total | publishable |
| (d) custom editor webview | stable | no | own implementation | total | publishable |

## 4. Diffs, edits, accept/reject in the chat UI

Stable building blocks, all in `vscode.d.ts`:

- Show a diff: `commands.executeCommand("vscode.diff", left, right, title)`. The command is registered in the workbench with args `left`, `right`, `title` ("Opens the provided resources in the diff editor to compare their contents."). `right` can be a virtual document served by `workspace.registerTextDocumentContentProvider(scheme, provider)` (L14493), verified as stable and commonly used for `git:`-style schemes.
- Register the scheme first, then open the diff:

```ts
const provider = new (class implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri) { return proposedText.get(uri.path) ?? ''; }
})();
context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('dsh-proposal', provider));
await vscode.commands.executeCommand('vscode.diff',
  realDoc.uri, vscode.Uri.parse(`dsh-proposal:${realDoc.uri.path}?id=${editId}`), 'DSH proposal');
```

- Apply edits: `workspace.applyEdit(edit: WorkspaceEdit, metadata?: WorkspaceEditMetadata)` (L14376) after re-reading the document and checking `version`; `workspace.fs` (`writeFile`, `delete`, `rename`) for create/delete/rename. `workspace.openTextDocument` (L14402) for opening the touched file.
- Accept / reject UI: `response.button(command: Command)` / `new vscode.ChatResponseCommandButtonPart(command)` (stable, L20358) with a registered command carrying the pending-edit id as argument; each button runs a normal `commands.registerCommand` handler. Alternative for a blocking prompt: `window.showInformationMessage(message, { modal: true }, 'Apply', 'Discard')` (L11285).
- Feedback signal: `ChatParticipant.onDidReceiveFeedback` (stable) gives thumbs up/down only, not per-edit accept/reject.

Proposed-only, therefore avoid: `stream.textEdit(uri, edits)`, `stream.textEdit(uri, true)`, `stream.workspaceEdit(fileEdits)`, `stream.notebookEdit`, `stream.externalEdit`, `stream.confirmation(title, message, data, buttons)` with `ChatRequest.acceptedConfirmationData` / `rejectedConfirmationData`, `ChatResponseMultiDiffPart`, `ChatResponseTextEditPart`, `ChatToolInvocationPart`, `stream.usage(...)`, and the accept/reject telemetry `ChatParticipant.onDidPerformAction` / `ChatUserActionEvent` with `ChatEditingSessionAction { kind: 'chatEditingSessionAction', uri, hasRemainingEdits, outcome }` and `enum ChatEditingSessionActionOutcome { Accepted = 1, Rejected = 2, Saved = 3 }`. All of these require `enabledApiProposals: ["chatParticipantAdditions"]`.

Consequence for the product: without the proposals there is no native "working set"/review UI and no native per-hunk accept/reject. The extension owns the whole edit-review loop: store pending edits in the extension host keyed by UUID, render a summary in chat (markdown plus `vscode.diff` anchor), and expose Apply / Show diff / Discard as chat buttons and commands.

## 5. Supporting stable APIs for an agent extension

- Secrets: `context.secrets` (d.ts L8640, `SecretStorage` with `get`, `store`, `delete`, `onDidChange`; event payload `SecretStorageChangeEvent` L8627). Store the DSH API key / token here, never in settings.
- State: `context.globalState` / `context.workspaceState` (`Memento`, L8585: `get`, `update`, `keys`, `setKeysForSync`). Use `workspaceState` for per-repo session index, `globalState` for last-used model.
- Configuration: `workspace.getConfiguration(section?, scope?)` (L14715) plus `workspace.onDidChangeConfiguration`; declare `contributes.configuration` with `scope: "application"` for machine-wide settings (Codex does this for `chatgpt.cliExecutable` and `localeOverride`).
- Commands and menus: `commands.registerCommand(id, cb)` (L10990), `contributes.commands` (`title`, `icon`, `category`, `enablement`), `contributes.menus` (`commandPalette`, `view/title`, `editor/title`, `editor/context`, `chatSessions/newSession` when the session proposal is available, `webview/context` with `webviewId == ...`). `commands.executeCommand("setContext", key, value)` for `when` clauses.
- Status bar: `window.createStatusBarItem(id, alignment, priority)` (L11641) with `StatusBarAlignment`, `text`, `tooltip`, `command`, `show()`/`hide()`; pass `id` so the item is stable and configurable.
- Output/logging: `window.createOutputChannel(name)` (L11526) or `createOutputChannel(name, { log: true })` → `LogOutputChannel` with `trace/debug/info/warn/error`.
- Terminal: `window.createTerminal(options)` (L11665; `TerminalOptions` and `ExtensionTerminalOptions` variants at L11674/L11683), `Terminal.sendText`, `window.terminals`, `window.onDidCloseTerminal`, `terminal.shellIntegration`. There is also `window.registerTerminalProfileProvider` for a terminal profile, if DSH should appear as a shell.
- URI handler: `window.registerUriHandler(handler)` (L11727) for `vscode://publisher.name/...` links (login callbacks).
- Workspace files: `workspace.findFiles`, `workspace.fs`, `workspace.applyEdit`, `workspace.openTextDocument`, `workspace.registerTextDocumentContentProvider`, `workspace.registerFileSystemProvider` (L14744, for a virtual `dsh:` scheme if session history should be browsable in the explorer).
- Optional stable bridges into other chat surfaces:
  - `lm.registerLanguageModelChatProvider(vendor, provider)` (L21118) with `contributes.languageModelChatProviders: [{ vendor, displayName, managementCommand? }]` and the three provider methods `provideLanguageModelChatInformation` (L20967), `provideLanguageModelChatResponse` (L20979), `provideTokenCount` (L20988). This makes DSH models selectable in native Chat / Copilot surfaces. License/policy caveat for Copilot Business/Enterprise BYOK applies.
  - `lm.registerTool(name, tool)` (L21045; doc comment at L21040 says the tool must also be declared in `contributes.languageModelTools`, required `name`, `displayName`, `modelDescription`, name pattern `^(?!copilot_|vscode_)[\w-]+$`) so DSH capabilities are callable from the native agent.
  - `lm.registerMcpServerDefinitionProvider(id, provider)` (L21109; requires `contributes.mcpServerDefinitionProviders: [{ id, label, when? }]`) if DSH should be exposed to the native agent as an MCP server instead of a webview.
- Note `lm.selectChatModels` and `LanguageModelTool*` types are stable, but `lm.fileIsIgnored`, `lm.onDidChangeChatRequestTools`, `LanguageModelToolInvocationOptions.chatStreamToolCallId`, `handleToolStream` are in proposed files.

## 6. Recommended architecture

Decision: ship option (c) + (d) — a webview chat in the secondary sidebar, plus an optional webview custom editor for conversation tabs — as the Copilot-replacing UI. Do not depend on `chatSessionsProvider`. Add stable bridges (language model provider, MCP server definition provider, DSH tools) only as optional extras.

Why not (a) as the foundation: it requires a proposed API that the Marketplace will not accept from a new publisher, it is dropped silently on a normal install, and it makes the product depend on a per-user launch flag. It is the right choice only if DSH also ships as a patched VS Code build (in which case add the id to `product.json#extensionEnabledApiProposals` and gain the native session list). Keep the session-list integration behind a feature check (`try { vscode.chat.registerChatSessionItemProvider(...) } catch { fall back }`) so the same VSIX can light it up when proposals are enabled, but never make it load-bearing.

Why not (b) as the foundation: participants are documented as deprecated and do not render in the default Copilot harness (`chat.defaultToCopilotHarness` default `true`); enabling them requires the user to switch harness. They are acceptable as a thin compatibility surface that forwards prompts to the same DSH backend, not as the main UI.

Minimum viable combination, all stable:

1. Webview chat view in `secondarySidebar` with an `activitybar` fallback container gated by a `when` context key (Codex pattern). Own input box, attachments via `workspace.findFiles` + quick pick, history in `workspaceState`, streaming via `postMessage`.
2. Extension host owns the DSH connection (stdio child process or HTTP), the secret (`context.secrets`), pending edits, and tool execution. Webview holds no credentials.
3. Edits: pending-edit registry + `vscode.diff` over a `dsh-proposal:` `TextDocumentContentProvider` + `workspace.applyEdit`; Accept/Discard as `response.button`/webview buttons bound to commands.
4. Optional `customEditors` viewType (e.g. `dsh.conversationEditor`) selected by `dsh-session:/**/*` so a conversation can open as an editor tab and be restored on reload (`registerWebviewPanelSerializer` for panels).
5. Optional stable bridges: `contributes.languageModelChatProviders` + `lm.registerLanguageModelChatProvider` so DSH models appear in native pickers; `contributes.mcpServerDefinitionProviders` + `lm.registerMcpServerDefinitionProvider` to expose DSH tools to the native agent. Both are additive and independently removable.

Proposed manifest skeleton:

```json
{
  "publisher": "<publisher>", "name": "dsh-vscode", "version": "0.1.0",
  "engines": { "vscode": "^1.146.0" },
  "main": "./out/extension.js",
  "activationEvents": ["onView:dsh.chatView", "onView:dsh.chatViewSecondary"],
  "contributes": {
    "viewsContainers": {
      "activitybar": [{ "id": "dshViewContainer", "title": "DSH", "icon": "media/dsh.svg",
        "when": "!dsh.supportsSecondarySidebar" }],
      "secondarySidebar": [{ "id": "dshSecondaryViewContainer", "title": "DSH", "icon": "media/dsh.svg",
        "when": "dsh.supportsSecondarySidebar" }]
    },
    "views": {
      "dshViewContainer": [{ "id": "dsh.chatView", "type": "webview", "name": "DSH Agent",
        "when": "!dsh.supportsSecondarySidebar" }],
      "dshSecondaryViewContainer": [{ "id": "dsh.chatViewSecondary", "type": "webview", "name": "DSH Agent",
        "when": "dsh.supportsSecondarySidebar" }]
    },
    "customEditors": [{ "viewType": "dsh.conversationEditor", "displayName": "DSH Conversation",
      "priority": "default", "selector": [{ "filenamePattern": "dsh-session:/**/*" }] }],
    "commands": [{ "command": "dsh.newChat", "title": "New DSH Chat", "icon": "$(plus)" },
                 { "command": "dsh.applyEdit", "title": "Apply DSH Edit" },
                 { "command": "dsh.showDiff", "title": "Show DSH Diff" },
                 { "command": "dsh.discardEdit", "title": "Discard DSH Edit" }],
    "configuration": { "title": "DSH", "properties": {
      "dsh.executablePath": { "type": "string", "scope": "application", "default": "dsh" },
      "dsh.model": { "type": "string", "default": "" },
      "dsh.autoApproveReadTools": { "type": "boolean", "default": true } } },
    "menus": { "view/title": [{ "command": "dsh.newChat", "when": "view == dsh.chatView", "group": "navigation" },
                              { "command": "dsh.newChat", "when": "view == dsh.chatViewSecondary", "group": "navigation" }] }
  }
}
```

Module map for implementers:

- `src/extension.ts` — `activate`: set `dsh.supportsSecondarySidebar` context key, register both webview view providers, custom editor provider, commands, URI handler, status bar item, secrets/config wiring.
- `src/dsh/client.ts` — transport to DSH (spawn `dsh` CLI or talk to its local HTTP API), streaming iterator, cancellation token bridge.
- `src/chat/webviewProvider.ts` — `WebviewViewProvider` for both view ids; CSP + nonce; `asWebviewUri` for `media/`; message protocol (`send`, `cancel`, `applyEdit`, `showDiff`, `newSession`).
- `src/chat/sessionStore.ts` — conversation metadata in `workspaceState`, transcript bodies in `globalStorageUri` files.
- `src/edits/pendingEdit.ts` — pending edit registry, `dsh-proposal:` content provider, `workspace.applyEdit` with version checks.
- `src/bridge/lmProvider.ts` (optional) — `LanguageModelChatProvider` mapping DSH models.
- `media/` — webview assets, built by esbuild.
- Packaging: `npx @vscode/vsce package` (works with no proposals), `engines.vscode: ^1.146.0`. `--no-dependencies` only when the bundle is fully bundled by esbuild.

Known gaps of this architecture, accepted: no native session list in the Agents/Chat view, no native attachment chips or `#` variable resolution (implement equivalents), no native edit-review UI (own diff flow), and no parity with Copilot's model picker inside the webview unless the optional LM provider bridge is added.

## 7. Local testing and debugging

Development host, verified flags in `cli.js` (`extensionDevelopmentPath: { type: "string[]" }`, `extensionTestsPath: { type: "string" }`, `"enable-proposed-api": { type: "string[]", allowEmptyValue: true }`, `"disable-extensions": { type: "boolean" }`, `"profile-temp": { type: "boolean" }`, `"inspect-extensions": { type: "string", allowEmptyValue: true }`):

```pwsh
# normal dev host for this repo
code --extensionDevelopmentPath="D:\WK_file\dsh-vscode-ok"

# isolated profile, no other extensions, verbose logs
code --extensionDevelopmentPath="D:\WK_file\dsh-vscode-ok" --disable-extensions --profile-temp --log=trace

# only when experimenting with the chatSessions proposal (unsupported for distribution)
code --extensionDevelopmentPath="D:\WK_file\dsh-vscode-ok" --enable-proposed-api=<publisher.name>

# attach a debugger to the extension host
code --extensionDevelopmentPath="D:\WK_file\dsh-vscode-ok" --inspect-extensions=9229
```

`launch.json` (`type: "extensionHost"`, `runtimeExecutable: "${execPath}"`, `args: ["--extensionDevelopmentPath=${workspaceFolder}"]`, `outFiles`, `preLaunchTask` for esbuild watch) is the supported inner loop. The `--extensionDevelopmentPath` flag can be repeated to load several extensions.

Tests: `@vscode/test-cli` + `@vscode/test-electron`, config `.vscode-test.mjs` with `defineConfig({ files, version, workspaceFolder, launchArgs, mocha })`; programmatic `runTests({ extensionDevelopmentPath, extensionTestsPath, launchArgs, vscodeExecutablePath })`; `downloadAndUnzipVSCode(version)` to pin 1.146.0; `resolveCliArgsFromVSCodeExecutablePath` when a CLI arg is needed. Constraint from the docs: on stable, running extension tests from the command line is only supported when no other Code instance is running, so use a temp profile or run through the debug config. Put `--disable-extensions` (and `--profile-temp` where useful) into `launchArgs`, and on Linux CI run under xvfb.

Logs and inspection:

- Output panel channel "Extension Host" for activation and uncaught errors; `Developer: Open Extension Logs Folder` (`workbench.action.openExtensionLogsFolder`) or `Developer: Open Logs Folder` (`workbench.action.openLogsFolder`) opens the directory; a running window writes `%APPDATA%\Code\logs\<timestamp>\window1\exthost\exthost.log` (on this machine the existing log dirs contain only `cli.log` because no GUI session has been logged there yet).
- `Developer: Show Running Extensions` (`workbench.action.showRuntimeExtensions`) shows activation time and whether the extension is `isBuiltin` / development.
- `--log=trace` (or `Developer: Set Log Level`) raises the extension host log level; `code --status` shows the running instance and its args.
- Webview debugging: `Developer: Open Webview Developer Tools` for the webview's DevTools; postMessage traffic can be logged in both host and webview consoles.
- To verify what the API actually grants, log `vscode.extensions.getExtension('<publisher>.<name>')?.packageJSON.enabledApiProposals` and wrap every proposed call in try/catch: with proposals stripped the gate throws the `CANNOT use API proposal` error synchronously.

## RECOMMENDATION

1. Build on stable APIs only: webview chat in `secondarySidebar` with `activitybar` fallback gated by a context key, plus an optional webview custom editor for conversation tabs. This is Codex's rendering strategy minus the proposed session list.
2. Do not build on `chatSessions` / `chatSessionsProvider`: it is a proposed API, the contribution is silently dropped unless the proposal is granted, and `vsce publish` refuses proposals outside the Marketplace allowlist.
3. Do not build on `chatParticipants` either: it is stable but documented as deprecated and does not render in the default Copilot harness (`chat.defaultToCopilotHarness` defaults to `true`).
4. Edits: pending-edit registry in the extension host, `vscode.diff` against a `dsh-proposal:` `TextDocumentContentProvider`, apply with `workspace.applyEdit` after a version check, Accept/Discard as registered commands invoked from chat buttons or webview buttons.
5. Keep credentials in `context.secrets`, session metadata in `workspaceState`, configuration in `contributes.configuration` with `scope: "application"` where machine-wide.
6. Add stable bridges only as options: `lm.registerLanguageModelChatProvider` (DSH models in native pickers) and `lm.registerMcpServerDefinitionProvider` (DSH tools for the native agent). Neither is required for the replacement UI.
7. Test with `code --extensionDevelopmentPath=... --disable-extensions --profile-temp --log=trace`; do not add `--enable-proposed-api` to the shipping story.
