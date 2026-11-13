# Reference implementations: how three DSH VS Code extensions are built

Read-only reverse engineering of the installed extensions under
`C:\Users\aaa_w\.vscode\extensions` (real path `D:\CDriveData\AppData\dotvscode\extensions`),
plus `openai.chatgpt` as a UX/architecture reference. Goal: harvest patterns for a new
extension that replaces the built-in Copilot agent with the DSH agent.

| package | version | entry | size | license | shape |
| --- | --- | --- | --- | --- | --- |
| lunnlew.dsh-vscode-companion | 0.6.14 | `out/extension.js` | 1.37 MB, 37.5k lines, esbuild CJS, not minified | MIT | 7 surfaces: in-editor chat webview, Simple Browser, `@dsh` participant, sessions tree, models tree, trajectory, team panel |
| fengze233.dsh-vscode-panel | 0.4.4 | `out/extension.js` | 135 KB, 3.1k lines | MIT | webview that iframes the dsh web UI + a bridge plugin installed into dsh |
| jager.dsh-vscode | 0.13.69 | `dist/extension.js` | 864 KB, 14.9k lines + 3.3 MB webview assets | MIT (LICENSE has conflict markers) | own webview chat UI + `@dsh` participant, attaches to an already-running server |
| baobaolaodie.dsh-tui-vscode | 0.7.7 | `out/extension.js` | 54 KB + 11 tsc modules | MIT | runs dsh-TUI in a real terminal, no chat webview |
| openai.chatgpt (Codex) | 26.1111.21308 | `out/extension.js` | 2.54 MB minified + 382 MB CLI | proprietary | registers a chat session type into the native Chat view, own webview elsewhere |

Bundle-reading trick that made all of this possible: all three DSH bundles are esbuild CJS
output that was NOT minified and that keeps `// src/<path>.ts` comments at every module
boundary. `Select-String -Pattern '^// src/'` recovers the full source tree with line
numbers. `out/*.js` in baobaolaodie is plain `tsc` output, one module per file.

---

# 1. lunnlew.dsh-vscode-companion 0.6.14

## 1.1 File map

`out/extension.js` is one bundle with four esbuild entrypoints for webviews and a hard
`size-limit` budget per artifact (a design decision worth copying: the build fails when a
surface grows).

| artifact | budget |
| --- | --- |
| `out/extension.js` | 1.40 MB |
| `out/chat/inEditorChat.webview/main.js` | 720 KB |
| `out/chat/trajectoryPanel.webview/main.js` | 96 KB |
| `out/host/modelsPanel/modelsPanel.webview/main.js` | 96 KB |
| `out/host/teamPanel/teamPanel.webview/main.js` | 96 KB |
| `out/chat/inEditorChat.imageWorker.js` | 4 KB |

Module map (bundle line): `config/{readConfig 14746, ConfigKeys 14751, resolveBin 14762, migrateLegacyLaunchToken 22388}`;
`kernel/server/{PortProbe 15128, DshProcessManager 15269+15830, readyRegex 15274, readinessProbe 15304, shutdownManifest 15427, orphanCleanup 15420, npmCacheResolver 16291}`;
`sdk/{wireResolver 10957, browserAuth 16471, cookieJar 16525, fileLock 16532, HttpCarrier 19389, EnvelopeParser 19491, HttpDshGateway 21285, StdioDshGateway 25017, DshCapabilities 22453, versionProbe 23187}`;
`kernel/lifecycle/{DshAccess 23280, InstanceRegistry 22831, RequestQueue 22977}`;
`host/sidebar/{SessionsProvider 17854, sessionScanner 17908, sessionRoots 17912, sessionWatchers 18107, sessionDataProcessor 18466, sessionEnrichment 21780, archivedSessionStore 21835}`;
`host/chat/{inEditorChat 26128, chatMessageHandler 28790+30943, mux/{remoteMuxAdapter 27278, remoteMuxFrame 27282, waterfall 27843}, binding/chatSessionBinder 29834, turn/{chatPromptRunner 30178, chatAskHandler 29236, chatAskDrainer 29508, queueHandlers 28794, dispatchSlashCommand 26295}, io/contextHandlers 23795}`;
`host/{modelsPanel 35066, teamPanel 36696, webviewShared/{restrictiveWebviewOptions 23947, webviewLoader 23969}}`;
`ChatParticipant 34757, streamRenderer 33208, requestAdapter 30210`.

## 1.2 Architecture

```
extension host                                  dsh web (child process or pre-existing)
+---------------------------+                   +--------------------------------------+
| extension.ts              |  execa spawn      |  dsh web --host 127.0.0.1 --port N   |
|  config/<keys>            |------------------>|  prints  "dsh web: http://h:p/?token=…"
|  kernel/server            |<------------------|                                       |
|    PortProbe (manifest)   |  stdout regex     |  GET /manifest.webmanifest            |
|    DshProcessManager      |  probe poll       |  GET /?token=…  -> 303 + set-cookie   |
|    shutdownManifest       |                   |  POST /api/<ns>/<method>  (JSON RPC)  |
|  sdk/HttpDshGateway ------+--- cookie ------->|  WS  /api/remote.mux                  |
|  kernel/lifecycle         |                   +--------------------------------------+
|    DshAccess: instance registry + request queue
|                           |
|  surfaces (all read the one gateway):
|    inEditorChat webview  <-> chatMessageHandler  (window-per-session)
|    @dsh chat participant <-> Waterfall + ChatStreamRenderer
|    SessionsProvider       <- sessionScanner (fs walk of ~/.dsh/sessions)
|    ModelsProvider         <- settings.mutate / credentials.* / agentPreset.list
|    TrajectoryPanel        <- host-side ring buffer of raw wire events
|    TeamPanel              <- agentTeam RPC (capability gated)
+---------------------------+
```

Every surface goes through one gateway object held in `kernel/lifecycle/DshAccess`, so
the server instance, the cookie, and the request queue are shared. Webviews never talk to
the server themselves: `connect-src 'none'` in the CSP makes that impossible by
construction.

## 1.3 Webview to host protocol (in-editor chat)

Host dispatch is one `switch (raw.type)` in `chatMessageHandler.ts:30943`.

Inbound (webview → host), with payload shapes where they matter:

- lifecycle: `ready`, `send`, `cancel`, `newSession`, `pickSession`, `openFile`,
  `requestSessions`, `switchSession{sessionId,parentSessionId}`,
  `load_older_history{sessionId,beforeSeq}`, `openTrajectory`
- slash: `slash{id,args}`
- queue: `queue_edit{sessionId,itemId,content}`, `queue_remove`,
  `queue_steer{sessionId,itemId,rpcId?,content?}`
- asks: `answerQuestion{answers:[{id,selected:[],custom?}],rpcId}`,
  `answerApproval{outcome,rpcId}`
- chips: `set_permission_preset{preset}`, `set_agent_preset{id}`, `set_effort{id}`,
  `set_model{providerId,modelId}`, `open_settings{key}`
- feedback: `feedback_put{sessionId,messageId,rating,note?,category?,ifVersion}`,
  `feedback_delete`, `feedback_list`
- context: `pickContext`, `request_mention_files`, `request_mention_folders`,
  `pasteImageChunk`, `pasteImageEnd`
- drafts: `save_composer_draft`, `restore_composer_draft`, `save_prompt_history`,
  `restore_prompt_history`
- subagents: `request_subagents`, `subagent_prompt`, `subagent_interrupt`, `subagent_peek`
- telemetry/status: `lifecycle_conversation_state{state}`, `lifecycle_subagent_count{count}`,
  `lifecycle_queued_count{count}`, `warning{message}`, `webview_debug{tag,message}`,
  `webview_error{tag,message}`

Outbound (host → webview): `error{message,details?}`, `info{message}`,
`sessionsAvailable{items}`, `effort_mode_changed{id,available}`,
`pickedContext{attachments}`, `mention_files{paths}`, `mention_folders{folders}`,
`submit_prompt{prompt,context}`.

Validation in `shared/webviewMessageContract.ts` (this is the part people skip and regret):
any message must be an object with a string `type`; `MAX_WEBVIEW_STRING_LENGTH = 8 MiB`;
`MAX_WEBVIEW_PATH_LENGTH = 4096`; control characters `/[\u0000-\u001f]/` rejected; arrays
bounded at 256 (`isBoundedArray`) and an over-budget `send` context is dropped with a
warning instead of throwing into the pump. `safePostToPanel` wraps each `postMessage` in
try/catch; `postChatError` posts a short `message` plus `details` (stack) so the webview
can show a details toggle.

Persistence and staleness:

- `panel.webview` state key `chatBinding` = `{sessionId, parentSessionId, cwd}`
  (`parseChatPanelState`, `panelRestore.ts:27249`) is what makes a restored tab land back
  in the same session.
- The script URI is cache-busted with `<packageVersion>+<mtime of main.js>`; the code
  comment says the same version tag was rebuilt once and every user kept the stale
  webview (`inEditorChat.webviewLoader.ts:27264`).
- CSP (`restrictiveWebviewOptions.ts`): `default-src 'none'; style-src 'unsafe-inline';
  script-src 'self'; img-src data:; connect-src 'none'; font-src 'self'`.

## 1.4 Streaming: the remote mux websocket

Paths: `REMOTE_MUX_PATH = "/api/remote.mux"`, `LEGACY_MUX_PATH = "/api/events.mux"`
(chosen by dsh version: remote.mux on >= 0.1.2-alpha.1, legacy below).

Frames:

- inbound only `{type:'item'|'end'|'error', streamId, value|error{code,message}}`
- outbound `{type:'open', streamId, endpoint, payload}` and `{type:'cancel', streamId}`
- `streamId = randomUUID()`; the WS upgrade carries `cookie` read fresh from the cookie
  provider on every connect, because the cookie rotates after each token exchange.

`Waterfall` (`mux/waterfall.ts:27843`) multiplexes three logical streams over one socket:
`session/follow`, `session/control`, `$events`; only kinds
`["session/event","session/projection","session/queue","approval/requested","question/requested"]`
are dispatched.

Exact payloads, because the server validates them strictly (`assertExactArguments`):

```
session/follow : {args:{request:{address:{kind:'session',sessionId}, assistantStream:true}}}
                 or address {kind:'subagent', parentSessionId, childSessionId, mode}
session/control: {args:{}}
$events        : {args:{}}
```

Two documented traps in the comments:

1. Sending `{args:{address}}` fails with `gateway/arguments-invalid: missing "request";
   unexpected "address"`, and the error envelope fails the inbox silently, so no live
   updates appear at all.
2. `assistantStream:true` is required from dsh v0.1.3-alpha.1: live assistant deltas are no
   longer emitted as durable chunk events, so without the flag `session/follow` disposes
   the subscription and the UI shows nothing until the settled `assistant/message`. Older
   hosts strip the unknown key in non-strict zod, so no version negotiation is needed.

Reconnect policy (`mux/remoteMuxAdapter.ts`): `openTimeoutMs 8000`, backoff base 250 ms,
cap 30000 ms, jitter 0.5, `maxAttempts 1000`, and an `_isOpening` guard so the close pump
cannot schedule a second reconnect.

Answers to approvals and questions go over HTTP, not the socket:

```
POST /api/$events/result
{type:'client-request', rpcId, method:'$events/result',
 payload:{args:{clientId, eventId, outcome}}}
```

`clientId` comes from the first `ready` frame on the `$events` stream; the POST response
is discarded and the authoritative confirmation is dsh's `approval/resolved` server request
on the socket. The comment records the bug this fixed: posting a bare
`{clientId,eventId,outcome}` is rejected by `clientRequestSchema` as
`gateway/bad-request: invalid client-request message`, the answer is swallowed, and the
approval listener then collapses the waterfall to `'unavailable'`
(`user-approval/src/index.ts:decide()`), dropping the user's decision without a trace.

Question outcomes: `{ok:false,error:{code:'cancelled',message:'user cancelled'}}` for an
empty answer set, otherwise `{ok:true,value:{answers:[{id,selected:[],custom?}]}}`;
approvals send `{ok:true,value:outcome}` with `outcome` a string such as `allowed-once` /
`rejected`. Both open a throwaway Waterfall, await `ready`, answer, abort.
`drainPendingAsks` reopens `session/follow` for `DRAIN_TIMEOUT_MS = 1500` to catch asks
that arrived while the POST was in flight.

Other protocol details worth knowing:

- The `session/control` baseline frame (a `session/queue` with no `sessionId`) is emitted
  once at open, BEFORE listeners attach; it is buffered in `_lastBaseline` and replayed.
- Queue state is read from the control projection `values.inbox`: `next-turn` means
  placement `queued`, `next-step` means `steering` when `source.kind === "user"` else
  `context`; each item can carry `source.rpcId` so a queued item maps back to its RPC.
- Follow streams are refcounted per address; subagent streams are keyed
  `sub:<parent>/<child>:<mode>`.
- HTTP RPC (`sdk/HttpCarrier.ts`): `POST /api/<namespace>/<method>`, body
  `{type:'client-request', rpcId, method:<endpoint>, payload}`, reply
  `{type:'server-response', rpcId, result}`. Version from `GET /manifest.webmanifest`,
  fallback RPC `host.describe` with rpcId `version-probe`.
- Slash commands: try `commands/execute {sessionId,line}` first, fall back to
  `session.prompt {sessionId, mode:'queue', content:[{type:'text',text:line}]}` on
  method-not-found / unknown command / HTTP 404.

## 1.5 Editor context injection

There is no `@active` file magic in this extension; one command and one set of
attachments do the work.

`dsh.sendSelection` (`sendSelection.ts:25829`): reads `activeTextEditor.selection` text,
`uri.fsPath`, `languageId`; cwd from the editor's workspace folder; `filePath` becomes
relative when inside cwd and a bare basename when outside, always forward slashes; optional
`showInputBox` prompt when `dsh.confirmBeforeSend`; builds
`selectionToBlocks({text,filePath,languageId})` → `[{type:'text',text:block}]` and appends
the prompt as a final text block; sends `session.prompt({sessionId, mode:'queue', content})`
against `pickOrCreateSession(cwd, stableSessionIdFor(cwd))`. If dsh is unreachable it
degrades to clipboard plus a toast ("selection copied to clipboard — paste into the panel")
rather than throwing.

`requestAdapter` flattens VS Code chat references into the prompt text, one line each:
`@<ref.id>: <ref.modelDescription || relativePath || fsPath>`, then the prompt, joined by
newlines. System-injected references are filtered by prefix:
`["vscode.instructions.","vscode.customizations.","vscode.implicit.","Browser"]` (the last
one because a chrome-devtools MCP tool surfaces as `Browser Pages` and floods the prompt).

Attachments (`io/contextHandlers.ts`): quick pick with "Add files / Add images / Add a
note / Add files + note"; shapes `{kind:'file',path,label}`, `{kind:'image',path,label}`,
`{kind:'note',text}`, `{kind:'focusedFile',path,label}`; client-side skip above 10 MiB with
the warning "DSH accepts up to 20 MiB per image"; mention list from
`workspace.findFiles("**/*", MENTION_FILE_EXCLUDE, 1024)` with
`{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.next/**,**/.cache/**,**/.DS_Store}`;
mention folders are the first-level directories of every workspace folder.

## 1.6 Sessions tree and Models tree

Sessions are read from disk, not from the API (`host/sidebar/sessionScanner.ts:17908`):
roots are `[{path: cfg.dshHome, kind:'dshHome'}]` plus optional `sessionsHome`; the scanner
prefers `<root>/sessions` then the root itself; layout is
`<root>/sessions/<encoded-cwd>/<sessionId>/{session.jsonl | session.jsonl.zstd | session.json}`;
anything matching `*.jsonl(\.zstd)?` is a candidate. Label = directory basename,
description = `decodeProject(encoded) · mtime.toLocaleString()`, sorted by mtime desc.
`decodeProject` turns `--D-Dev-foo--` into `D:/Dev/foo` (a leading single-letter segment is
a drive). Watchers are two-fold on purpose: globs
`sessions/**/*.{json,jsonl,jsonl.zstd}` plus dir globs `["sessions","sessions/*","sessions/*/*"]`,
because a new session directory appears before its data file and the tree would otherwise
miss the row for a moment.

Models data comes from RPC: `session.models`, `session.selectModel`, `agentPreset.list`,
`settings.mutate`, `credentials.*`. Provider deactivation snapshots the provider entry into
extension state and removes it via `settings.mutate`, so re-activation can restore it.

## 1.7 Server lifecycle: reuse, spawn, auth, reaping

Assessment order on activation: TCP probe + `GET /manifest.webmanifest` (max 1 MiB, 2xx)
and the body must carry `name === DSH_MANIFEST_NAME`; failure reasons are
`timeout | unreachable | wrong-server | malformed-manifest`. When `dsh.port` is 3080 and
`reuseExisting` is on, an already-running dsh is adopted instead of spawning.

Readiness has two independent paths, and both are needed:

- stdout regexes: `^dsh web:\s*http://<host>:(\d+)`, `^deepseek[- ]harness web:\s*http://<host>:(\d+)`,
  `^listening on http://<host>:(\d+)`, `^http://<host>:(\d+) \(listening\)`,
  `^ready:\s*http://<host>:(\d+)`. The host in the line must equal the allowed host.
- HTTP polling of `/manifest.webmanifest` in <= 500 ms attempts with 50-200 ms backoff.

If HTTP answers but stdout never printed a `?token=` line, the manager refuses to adopt:
"dsh at host:port answered the readiness probe but never published a launch token — likely
an orphan from a previous session (or an externally-launched dsh) is bound to this port
(pid N). Stop it and retry." That refusal is the difference between a confusing half-dead
UI and a clear error.

Spawn: `execa` with `stdio:['ignore','pipe','pipe']`, `windowsHide:true`,
`killSignal:'SIGTERM'`, `forceKillAfterTimeout:5000`; the comment explains that without the
force-kill timeout the SIGTERM only kills the `cmd` shim and never reaches
`node apps/cli/src/bin.ts web`. Env carries `DSH_HOST`/`DSH_PORT`; stderr keeps a 4096-byte
tail for error messages; `onUnexpectedExit` only fires when the child dies within
`DEFAULT_UNEXPECTED_EXIT_GRACE_MS = 5000` of readiness (later deaths are "the server died",
not "start failed").

Auth: token comes from the `?token=` stdout line; `exchangeToken` does
`GET <base>/?token=<t>` with `redirect:'manual'`, requires HTTP 303, and takes the
`set-cookie` pair (timeout 5 s). That cookie is sent as the `cookie` header on every RPC and
on the WS upgrade. The jar at `~/.dsh/dsh-vscode-cookies.json` (version 1) is guarded by a
file lock: `open(lockPath,'wx')` with a marker string, `STALE_LOCK_MS 5000`,
`RETRY_DELAY_MS 25`, `MAX_RETRIES 200`, release only when the marker still matches.

Zombie reaping: `~/.dsh/dsh-vscode-shutdown-manifest.json` with
`{version:1, spawns:[{pid,port,startedAt,executableCwd?,ownerHostPid?}]}`, capped at 16
entries, written atomically (temp file + `handle.sync()` + rename); corrupt JSON is treated
as empty with a warning. Each extension host writes its own shard
`<manifest>.json.<ownerHostPid>.json` and reads merge all shards deduped by pid, which is
what makes multi-window safe. On activation `cleanupPreviousSpawns` skips entries older
than 24 h, skips dead pids, skips entries owned by a different still-live host, and skips
pids that look reused by comparing the process creation time against `startedAt` with a
window of -330 s .. +60 s (Windows via `Get-CimInstance Win32_Process`, Linux via
`/proc/<pid>/stat` + btime). Only then does it `taskkill /F /PID <pid> /T` on Windows or
SIGKILL elsewhere.

Status bar: `$(radio-tower) dsh: stopped | starting… | running :3080 (reused) | running :3080`;
click starts when stopped, otherwise opens the panel.

## 1.8 How approvals surface

Two paths, one authority.

- In the in-editor webview: `approval/requested` becomes a modal with the tool name and
  reason; the modal answers through `answerApproval{outcome,rpcId}` → `$events/result`.
- In the native chat participant: the participant cannot pause mid-turn, so pending
  approvals are stored in a Map keyed by mux rpcId and resolved on the NEXT handler
  invocation by reading `request.acceptedConfirmationData` / `request.rejectedConfirmationData`,
  matching `{rpcId, approvalId}`, and forwarding `{ok:true, value:"allowed-once"}` or
  `{ok:true, value:"rejected"}`.

That confirmation-data round trip is the only supported way to get approval UX inside
`vscode.chat` without the proposed `chatSessionsProvider` API.

## 1.9 The `@dsh` chat participant

`vscode.chat.createChatParticipant(id, handler)` with `id` from `dsh.chatId` (default
`dsh`), icon, and a master switch `dsh.chatParticipant`. A turn: cwd from the active editor
or the first workspace folder; if `request.command` is set, dispatch to the slash behavior
table (outcomes: apply-preset, open-picker, execute-host, execute-host-then-send,
open-session-picker, unknown-command); otherwise stream a prompt.

Streaming: data comes from a Waterfall subscription, and a `ChatStreamRenderer` is flushed
on `setInterval(..., IDLE_FLUSH_INTERVAL_MS = 120)` with `{skipReasoning:true}` so partial
tokens do not thrash the markdown renderer; event switch over `assistant/chunk`,
`tool/call`, `tool/result`, `assistant/message`, `turn/end`,
`question/requested|approval/requested`; `STREAM_MAX_EVENTS = 4000` then a truncation
notice; `wf.close()` in `finally`.

Thread to session mapping is persisted in `globalState` under
`dsh-vscode.threadSessionMap.v2`, so re-opening the same native chat thread continues the
same dsh session.

## 1.10 Configuration keys (defaults are the design decisions)

Process: `dsh.executable "npx"`, `dsh.executableArgs ["--yes","@deepseek-ai/dsh@0.1.7-alpha.2","web"]`
(exact version pin; a bare `@deepseek-ai/dsh` is rewritten to the pin at read time),
`dsh.executableCwd ""` (empty = active editor or first folder; a per-call cwd still wins),
`dsh.host "127.0.0.1"`, `dsh.port 3080` ("3080 reuses an already-running dsh; 0 disables
reuse so the OS picks a free port each launch"), `dsh.reuseExisting true`,
`dsh.probeTimeoutMs 800`, `dsh.dshHome "${userHome}/.dsh"`, `dsh.sessionsHome ""`,
`dsh.startTimeoutMs 300000` (cold npx download), `dsh.warmStartTimeoutMs 30000`,
`dsh.killExternalOnStart "prompt"` (boolean or "prompt": on collision show a 5-second
countdown toast with a cancel button, then force-kill; lookup via `Get-NetTCPConnection`
on Windows, `lsof -iTCP:<port> -sTCP:LISTEN -t` on macOS/Linux), `dsh.trustedHosts []`,
`dsh.profile ""`, `dsh.autoStart false` (opt-in; the reuse probe still runs first),
`dsh.jsonrpcBridge false`, `dsh.jsonrpcAgentBin ""`, `dsh.jsonrpcConfigPath ""`,
`dsh.sessionsViewMode flat|tree` (`flat`).

Auth: `dsh.tokenConfigured false` (UI hint only; the real token lives in SecretStorage under
"dsh: Set Launch Token").

Chat: `dsh.confirmBeforeSend true`, `dsh.chatParticipant true`, `dsh.chatIncludeReferences true`,
`dsh.chatExcludeReferenceIdPatterns` (the four prefixes above), `dsh.chatDebugReferences false`,
`dsh.chatId "dsh"`, `dsh.chatStream websocket|poll` (`websocket` streams over the mux;
`poll` shows "Done." after idle; the mux path is resolved from the build), and the chip
state `dsh.agentPreset ""`, `dsh.permissionPreset read-only` (note: the runtime permission
is changed by dsh's own `/permission` command, this is only the chip), `dsh.effort ""`,
`dsh.model ""` stored as `<providerId>:<modelId>`.

UI: `dsh.reuseSimpleBrowserTab true` (reuse a tab by URL fragment or page title
"DeepSeek Harness").

Encoding note: both `package.json` and `README.md` are clean UTF-8 (verified: no U+FFFD, no
GBK-mojibake code points baked in). Printing them through `Get-Content` in a console whose
code page is GBK produces the familiar `鈥?` garbage, which is a terminal artifact, not a
packaged defect; read manifest text with an explicit UTF-8 decode when the exact characters
matter.

The shipped `e2e/` directory is the real gem: `helpers/MockDshServer.ts` (25 KB) is a
mock dsh that speaks the mux and RPC protocol, `hostCleanup.ts` (26 KB) reaps leaked
servers between tests, and `ui/pages/InEditorChat.ts` (43 KB) is a page object that drives
the webview through its real protocol. Copying that test topology is cheaper than debugging
the wire against a live server.

---

# 2. fengze233, jager, baobaolaodie

## 2.1 Feature matrix against lunnlew

| capability | lunnlew | fengze233 | jager | baobaolaodie |
| --- | --- | --- | --- | --- |
| starts dsh itself | yes (npx pin, cold-start aware) | yes (npm shim / desktop runtime / node bin.js) | yes but prefers attaching to `dsh.url` | yes, spawns the TUI in a terminal |
| embeds dsh web UI | Simple Browser tab | iframe inside a webview (activitybar + secondary sidebar) | own webview UI, no iframe | none |
| native `@dsh` participant | yes, with confirmation round trip | no | yes, with tool cards + approval buttons | no |
| in-editor chat webview | yes (main surface) | no (the whole web UI is the surface) | yes (`dsh.chatView`) | no |
| sessions list | tree from disk + enrichment | no | own webview session list | tree from `sessions/*/session.jsonl(.zstd)` |
| process cleanup | shutdown manifest + shards + pid-reuse check | parent-exit hook + taskkill | taskkill /T /F | terminal kill picker |
| auth handling | token capture, 303 exchange, cookie jar + lock | token in URL, panel pastes token when unknown | token capture + log re-scan, retry once on DshAuthError | delegated to the TUI |
| port conflicts | strict refuse + external-kill prompt | free-port fallback over 50 candidates, 3 rounds | assumes 3080 | n/a |
| extras | models tree, trajectory, team panel, e2e suite | bridge plugin install + i18n (zh/en), uninstall hook | git rollback plugin, 13 locales, context meter | IDE selection channel over local WS |

## 2.2 fengze233: iframe plus a bridge plugin

The whole UI is the real dsh web app in an iframe
(`<iframe id="dsh-frame" allow="clipboard-write" src="http://host:port/">`), zoomed by a
CSS variable from `dsh.panel.zoomLevel`, with shell states `readyPage`, `stoppedPage`,
`disconnectedPage`, `authRequiredPage`, `remoteDisabledPage`. This avoids reimplementing
chat, at the cost of a cross-origin-like message bridge for things a web page cannot do
(open external, open file, clipboard, save image, read text).

Bridge handshake inside the webview: a nonce'd inline script holds
`TOKEN = crypto.randomUUID()` and posts `{kind:'bridgeHello', token, imageFallback}` into
`iframe.contentWindow` every 250 ms up to 60 attempts until it receives
`{kind:'bridgeAck', ok}`. The polling is deliberate: the iframe materialises 1.5-3 s after
load, so a post on the iframe `load` event either races or never arrives. Inbound messages
are accepted only when `e.source === iframe.contentWindow` and the origin is allowlisted;
outbound uses `'*'` because the receiver is pinned by `contentWindow` and the hello carries
the secret. The design comment states the trust model plainly: a malicious frame without
the token never acks, so the bridge stays closed.

Server extension without forking: `src/bridge/installer.ts` copies a package
`dsh-vscode-bridge` into `<dshHome>/profiles/<profile>/node_modules/` and patches
`<dshHome>/profiles/<profile>/cordis.patch.yml` between the markers
`# dsh-vscode-bridge: begin` and `# dsh-vscode-bridge: end` (variant
`begin was-empty-array` when the patch file was `[]`). It handles an empty file, an empty
top-level array, duplicated pasted blocks, unusable existing copies, rollback on copy
failure, a `skipForeignTarget` guard against global `node_modules` directories containing
`*.cmd`, and returns `{status:'degraded', reason}` instead of throwing. Cleanup runs from a
non-standard `"uninstall": "node ./out/uninstall.js"` manifest field.

Launch resolution on Windows: prefer an explicit `executablePath`; npm path is a `dsh.cmd`
on PATH whose directory is not inside `DeepSeek Harness\resources\runtime`, and its
`node_modules/@deepseek-ai/dsh/lib/bin.js` is executed with `node.exe` directly to "bypass
the cmd quoting layer"; desktop path is
`%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`, preferring a
sibling `bin.js`, else `cmd.exe /d /s /c ""<script>""` with `windowsVerbatimArguments:true`.
Node is found as sibling `node.exe`, then PATH, then `process.execPath` only when not
running inside Electron. Spawn args: `--profile <p> --host <h> --port <n> [...] --no-open`
unless `openInBrowser`; `detached` only on POSIX; stop does `taskkill /pid <pid> /T /F`
then SIGTERM, 3 s grace, then SIGKILL.

`ServiceManager` is the best small state machine among the three: state
`idle|detecting|starting|ready|stopping|failed` with the in-flight promise as a mutex so
concurrent `ensureRunning()`/`restart()` share one flow; a `stopRequested` flag checked
after every await so a stop during start still kills the child that just appeared; stdout
reassembly with a `stdoutPartial` buffer because chunk boundaries split lines; a
`noOpenDisabled` latch that learns from stderr (`unknown option` + `no-open`) to stop
passing `--no-open` to old dsh builds; a 45 s start timeout, a 30 s health timer after
ready to catch "process alive but service dead", and up to 3 free-port rounds.

## 2.3 jager: attach-first, own UI, mechanical protocol drift

Attaches to an already-running server (`dsh.url` default `http://127.0.0.1:3080`) and only
spawns when `dsh.autoStart` and the URL is dead. Token handling is the interesting part:
it captures `token=([A-Za-z0-9_-]+)` from stdout, and when that fails (server started by a
terminal or a previous extension instance) `refreshLaunchToken()` re-reads the known log
location up to 8 times with `500 ms` sleeps; the API client retries once after a
`DshAuthError` and surfaces "服务器要求授权(0.1.2 起 /api 需要签名 cookie),但未取得启动 token"
when it still has nothing.

Its streaming code pins down a second, newer contract: dsh 0.1.5 emits per-token deltas as
`assistant-stream` frames carrying `attemptId` and a monotonic `index`; `start` registers
`{attemptId,turn,step,nextIndex:0}`, `chunk` is forwarded only when the attempt matches and
`frame.index === nextIndex` (a gap drops the frame until the next start, since a gap means
the stream was re-attached mid-flight), and `end` carries `outcome` committed vs abandoned
(abandoned means the UI discards the text it already streamed). If you build a streamer,
handle both contracts: the `assistantStream:true` flag plus durable chunk events, and the
attemptId/index deltas.

Turn-level Git rollback: a bundled dsh plugin (`resources/dsh-git-rollback/`) snapshots
tracked and untracked files at each turn start into hidden refs
`refs/dsh/checkpoints/<sid>` with records under `.dsh/rollback/<sessionId>.json`
(`{checkpoints:[{turn,commit,time,untracked[]}], rolls:[]}`), invoked through
`execFile(gitPath, ["-c","core.quotepath=false", ...], {env:{GIT_OPTIONAL_LOCKS:"0"},
maxBuffer:8MB, timeout:30s})`, with the git binary resolved from the built-in git
extension (`vscode.extensions.getExtension("vscode.git").exports.getAPI(1).git.path`).
Both the rollback plugin and the plugin-install path are reuse candidates; the ref namespace
trick keeps the user's branch history untouched.

Changelog as documentation: 215 KB of entries, each stating the symptom, the mechanism and
the verification count. Two entries are directly useful. 0.13.69: model and effort pills
showed the deployment default because `session/modelCatalog` returns only the catalog
default, while the per-session choice lives in the `modelSelection` projection (`next` is
what the next request uses, `lastUsed` is what the last request actually used); the fix
reads `session/projections`, and it also had to clear a stale `reasoningEffort` when the new
model has none, and to `await` the configured effort before the first state push (a push
race showed the default briefly). 0.13.67: a mechanical API diff against dsh v0.2.2-rc.1 —
endpoints 173 → 224 (53 added, 2 removed, 2 changed), forwarded events 23 → 25, session
projections 21 → 25, 60 session-event types unchanged; `schedule/delete` and
`schedule/update` removed, `schedule/list` changed from array to page object,
`session/page` gained a cursor, and payloads now require a `request` wrapper (a flat
payload never satisfied the envelope). Expect the wire to move; version-gate and diff
mechanically instead of trusting docs.

## 2.4 baobaolaodie: a terminal-first integration with an IDE channel

No chat webview at all: it spawns `dsh-tui` in a VS Code terminal, decodes
`session.jsonl.zstd` with a bundled `@bokuweb/zstd-wasm` to build the sessions tree, and
inserts `@path#Lx-y` mentions into the terminal with `ctrl+alt+k`. What generalises is the
IDE channel (`out/ide/server.js`, 461 lines with full ADR comments): a loopback WebSocket
server plus a lock file `<lockRoot>/ide/<port>.lock` containing
`{port, token, workspaceFolders, pid}` (directory 0700, file 0600), discovered either
through injected env `DSH_TUI_IDE_PORT` / `DSH_TUI_IDE_TOKEN` or by scanning lock files.
Handshake is protocol version 2: the client's first frame is
`{"method":"ide/hello","params":{"token","protocolVersion"}}`, the server answers
`{"method":"ide/hello_ack","params":{"protocolVersion","workspaceFolders"}}`; a bad token
gets no ack and the socket is dropped, and the client treats open-without-ack as
unauthenticated and tries the next candidate. Selections then flow as
`selection_changed{path,startLine,endLine,isEmpty,text,documentVersion}` with 0-based
inclusive ranges and the live buffer text (unsaved edits included). The last non-empty
selection is replayed right after the ack, with `markReplaySuppressed()` to avoid retyping a
frame the extension already inserted as text.

That file also documents a real off-by-one that any selection-forwarding extension will hit:
VS Code's `selection.end` is the position AFTER the last selected character, so a selection
ending at column 0 (Shift+Down, triple click, drag to gutter) has `end.line` one greater
than the last covered line, and `getText()` includes that line's newline. Normalise at the
producer: `endLine = (character === 0 && line > startLine) ? line - 1 : line`, because every
consumer (footer badge, `#Lstart-end` mention, disk fallback) counts an inclusive range;
otherwise the badge says 4 lines while the transcript says 3.

## 2.5 Are they forks of each other

No. String-level cross checks: `lunnlew`, `Fengze233`, `Jager`, `NEXTINDIE`,
`baobaolaodie` appear zero times inside any of the other bundles, and jager's bundle
contains none of lunnlew's distinctive identifiers (`shutdown-manifest`, `chatBinding`,
`remoteMuxAdapter`, `LifecycleBackedWebview`, `inEditorChat`, `stableSessionIdFor`). They
are three independent builds against the same server API. lunnlew and jager share the
esbuild + module-comment build convention, which is tooling lineage, not shared source.
jager's LICENSE carries unresolved merge markers and a dual copyright
(`<<<<<<< HEAD / Copyright (c) 2025 dsh-vscode contributors / ======= / Copyright (c) 2026 Jager`),
so it descends from an older repo of the same name that is not installed here.

---

# 3. openai.chatgpt (Codex) as a UX and architecture reference

## 3.1 How it registers into the native Chat view

`package.json`: `engines ^1.96.2`, `extensionPack: ["openai.codex-audio"]`,
`enabledApiProposals: ["chatSessionsProvider","languageModelProxy"]`, and a
`contributes.chatSessions` entry
`{type:"openai-codex", name:"Codex", displayName:"OpenAI Codex", description:…}` plus
`menus["chatSessions/newSession"] = [{command:"chatgpt.newCodexPanel", when:"chatSessionType == openai-codex"}]`.

Runtime: `vscode.chat.registerChatSessionItemProvider(...)` inside a try/catch whose catch
logs "Codex chat session item provider not registered", i.e. when the proposed API is
missing the extension silently degrades to its own webview. There is no
`chatParticipants` contribution and no `registerChatParticipant` call anywhere, so Codex
does not appear as `@codex` in the old participant model.

Sidebar placement is feature-gated rather than branched per version:
`{major:1,minor:106}`, context key `chatgpt.doesNotSupportSecondarySidebar` set via
`setContext`, two view containers (`codexViewContainer` in activitybar when that key is
true, `codexSecondaryViewContainer` in secondarySidebar when false) and a helper that picks
`{containerId,viewId}`. The same trick gates the `ctrl+n` keybinding through a
`chatgpt.supportsNewChatKeyShortcut` context key so it does not steal the shortcut
unconditionally.

## 3.2 UX patterns worth copying

- Thread list plus new-session menu is the primary navigation; sessions are durable local
  records, and the thread catalog is a SQLite database under `globalStorageUri` with scan
  checkpoints (`local_thread_catalog_*` tables) so a restart does not rescan everything.
- Composer: `composerEnterBehavior: enter | cmdIfMultiline | cmdAlways`, large rounded
  input, and a pill toolbar (model, reasoning effort, approval mode) with a context meter
  ring that turns amber at 75 % / red at 90 % and offers "Compact context".
- Queued follow-ups as a first-class object: `followUpQueueMode: queue | steer | interrupt`
  (default `queue`), persisted at `queued-follow-ups.json`, rendered by
  `queued-message-list`, each item individually editable/removable/steerable.
- Tool cards: `item/started` … `item/completed` events per tool call, one-line summary rows
  with expandable arguments and results, plus a per-turn summary line
  ("1 command · read 1 file · searched 2 times") that folds the whole run.
- Diff review: `turn/diff/updated` streams the turn's diff; `reviewDelivery: inline |
  detached` chooses whether the diff opens in the panel or a separate editor; a
  `file-viewer` with git blame and a file-access approval prompt backs it.
- Approval cards: `composer-approval-request-card`, `automatic-approval-review`,
  `auto-review-approval-nudge`, with approval policies
  `["read-only","auto","granular","guardian-approvals","full-access","custom"]`.
- Working-set attachments: `attachments`, `browser-file-attachments`,
  `composer-attachment-actions`, `chatgpt.addFileToThread` / `chatgpt.addToThread`.
- Checkpoints: `checkpoint`, `outgoing-chat-checkpoint`, so a turn can be rewound, and
  `conversation-plan-files` keeps plan files as artifacts.
- Inline annotation threads on artifacts (`annotation-comment-*`) and a background terminal
  tab for long commands (`local-conversation-background-terminal-tab`).
- Version-gated capability map: features keyed by the bundled CLI version
  (`applyPatchPreserveLineEndings:"0.148.0-alpha.6"`, `threadItemAnchors:"0.159.0-alpha.2"`,
  `gatewayOAuth:"0.157.0-alpha.11"`), so one extension build serves many CLI versions.

## 3.3 Message plumbing worth copying

`ChunkedWebviewMessageSender` splits large payloads into chunks and treats the
`postMessage` return value honestly:
`postMessage(...).then(ok => { if (!ok) this.sender.dispose(panel) })` — a false or absent
ack means the panel is gone and the sender is disposed instead of leaking. Message handler
binding is per session id, and switching sessions disposes the previous binding.

## 3.4 Minimum reproducible without the private backend

Directly reproducible on top of dsh:

- `chatSessionsProvider` registration with try/catch fallback, if the team is willing to
  depend on a proposed API; otherwise `createChatParticipant` (lunnlew's route) plus a
  webview for rich surfaces.
- durable local thread catalog (SQLite or JSON) mapping native chat thread → dsh session,
  with scan checkpoints.
- queued follow-ups with `queue | steer | interrupt` semantics, persisted, with per-item
  edit/remove.
- composer pills and a context meter computed from `session/projections` (usage and window).
- tool cards driven by dsh session events `tool/call` and `tool/result`, with a per-turn
  summary line.
- diff review driven by dsh's own file-write tool results plus `git diff`, with inline vs
  detached delivery, and hidden-ref checkpoints (jager's rollback plugin already does this).
- version-gated capability map keyed on `/manifest.webmanifest` version.

Not reproducible: the model, the app-server protocol, sandbox setup, and the diff-apply
implementation inside `codex.exe`.

---

# 4. Lessons and pitfalls visible in the code

1. Port conflicts. lunnlew distinguishes three cases (our child on an old port, a foreign
   process, an orphan dsh without a token) and refuses to adopt the third; fengze233 scans
   up to 50 ports with `probeService` and retries 3 rounds; jager assumes 3080. The failure
   mode that hurts is adopting a server you cannot authenticate against: it answers HTTP,
   the UI renders, then every RPC 401s.
2. Token handling. Capture from stdout is not enough: jager re-reads logs 8 × 500 ms and
   retries once on `DshAuthError`; lunnlew keeps the cookie in a lock-guarded jar because
   two windows exchanging tokens concurrently otherwise clobber each other.
3. Zombie processes. Killing by pid alone reaps the wrong process after pid reuse. lunnlew's
   manifest + owner-host shards + creation-time window is the only implementation here that
   survives both restarts and pid reuse; plain `taskkill /T /F` (fengze233, jager) is fine
   while the host lives and wrong after it dies.
4. Webview persistence. Store the binding in `webview.state`, not in a global map, or a
   restored tab shows an empty chat; cache-bust the script URI from file mtime or users get
   the previous build after an update.
5. Reconnect and backoff. A single `_isOpening` guard plus jittered exponential backoff
   (250 ms → 30 s) prevents socket storms; buffering the baseline frame that arrives before
   listeners attach prevents a permanently empty queue strip.
6. Session switching. Read per-session state (model, effort, permission) from projections,
   not from the catalog default, and clear fields the new model does not have; `await` the
   state write before the first UI push or the pill flickers to the default.
7. Text and line endings. Normalise selection end lines at the producer (the column-0 case
   in 2.4); keep `core.quotepath=false` and `GIT_OPTIONAL_LOCKS=0` when shelling out to git
   for diff display; decode files as UTF-8 explicitly and never trust a console that renders
   `鈥?` for an em dash (all four packaged manifests here are clean UTF-8; the mojibake seen
   during this recon was a GBK console artifact).
8. Electron vs npm launch. Inside VS Code `process.execPath` is `Code.exe`, not node;
   resolve a real `node.exe` (sibling shim, PATH) and spawn `bin.js` directly, or the child
   never starts. Also pass `--no-open`, and be ready to drop the flag for old builds.
9. Extension host restart. Kill-on-exit hooks (`process.once('exit')`) do not run when the
   host is killed, so cleanup must also happen on the next activation (lunnlew does both).
10. Envelope strictness. `assertExactArguments` and zod reject extra or missing keys; a
    rejected envelope can fail silently, so log wire errors into the panel and treat a failed
    inbox as a first-class error state.
11. Stream contract drift. Two contracts exist (`assistantStream:true` durable chunks; and
    `assistant-stream` frames with `attemptId` + monotonic `index`). Support both, drop
    out-of-order chunks, and discard text from abandoned attempts.
12. Webview script hazards. Do not redeclare `vscode` across inline scripts (a duplicate
    top-level declaration throws SyntaxError and kills the whole script); validate
    `event.source === iframe.contentWindow` for any iframe bridge.
13. Approval loss. Answering over the wrong channel fails silently and drops the user's
    decision; watch for the `approval/resolved` server request as the only proof the answer
    landed.
14. Protocol churn. Endpoints and payload wrappers change between dsh releases
    (173 → 224 endpoints, `request` wrappers required); version-gate and diff mechanically
    instead of trusting stale docs.
15. Manifest hygiene. jager shipped a LICENSE with conflict markers and a 215 KB changelog
    inside the VSIX; keep the packaged file list explicit.

---

# 5. Reuse list

```
adopt  probe-then-decide: GET /manifest.webmanifest, require name === DSH_MANIFEST_NAME, else spawn; reuse only when port === 3080 && reuseExisting && probe === 'dsh'
adopt  one gateway per host (instance registry + request queue); webviews never fetch: CSP default-src 'none'; script-src 'self'; img-src data:; connect-src 'none'
adopt  session/follow {args:{request:{address, assistantStream:true}}}; buffer the control baseline frame; 250ms..30s jittered backoff with an _isOpening latch
adopt  approvals: POST /api/$events/result with the exact client-request envelope; clear the modal only on the approval/resolved server request
adopt  reap: ~/.dsh/dsh-vscode-shutdown-manifest.json sharded per host pid; skip pids whose creation time falls outside startedAt-330s..+60s; taskkill /F /T
adopt  ServiceManager: mutex over start/stop, stopRequested checked after every await, 45s start timeout, 30s health probe, free-port fallback (50 candidates, 3 rounds)
adopt  Windows launch: process.execPath is Code.exe; resolve node.exe and spawn dsh/lib/bin.js directly; pass --no-open and drop it when stderr says unknown option
adopt  webview: panel state {sessionId,parentSessionId,cwd}; cache-bust the script by main.js mtime; validate envelopes (8 MiB strings, 4096 paths, no control chars, arrays <= 256)
adopt  sessions tree from ~/.dsh/sessions with file + dir watchers and decodeProject(cwd)
adopt  queue modes queue|steer|interrupt with per-item edit/remove/steer and a persisted file
adopt  MockDshServer e2e harness: mock the mux and RPC, drive the webview through its real protocol
avoid  iframe-embedding the dsh web UI as the main surface (needs a bridge, fights CSP, breaks under remote/SSH tunnels)
avoid  adopting a server that answers HTTP but never printed ?token= (fail loudly instead)
avoid  pid-only kills without a creation-time check; avoid detached:true on Windows
avoid  a hardcoded dsh version in executableArgs with no settings override
avoid  chatSessionsProvider as a hard dependency (proposed API; keep a participant + webview fallback)
```

---

# 6. Licensing

- lunnlew.dsh-vscode-companion: MIT, "Copyright (c) 2026 lunnlew contributors", repo
  https://github.com/lunnlew/dsh-vscode.
- fengze233.dsh-vscode-panel: MIT, "Copyright (c) 2026 Fengze233", repo
  https://github.com/Fengze233/dsh-vscode.
- jager.dsh-vscode: MIT text with unresolved merge markers and dual copyright
  (2025 dsh-vscode contributors, 2026 Jager), repo
  https://github.com/NEXTINDIE/DeepSeek-Harness-for-VS-Code.
- baobaolaodie.dsh-tui-vscode: MIT (declared in `package.json` and `dsh-plugin.json`).
- openai.chatgpt (Codex): `SEE LICENSE IN LICENSE.md`, body
  "See https://openai.com/policies/row-terms-of-use." — proprietary, no code reuse; only
  publicly visible UX behaviour is described here.

MIT permits copying snippets, including into a differently licensed product, provided the
copyright notice and permission notice are retained. Practical rule for this project:
reimplement rather than copy, and where a nontrivial snippet or a whole module is taken
from lunnlew or fengze233, add the MIT notice with the original copyright line and a
`NOTICE`-style attribution (package name, repo URL, file path). Nothing in this document
copies code: it records identifiers, protocol shapes and design decisions. The safest
posture is to treat the wire protocol (dsh's own, not the extensions') as the shared
contract and write our own client against it, using these extensions only as evidence of
what the server will and will not accept.
