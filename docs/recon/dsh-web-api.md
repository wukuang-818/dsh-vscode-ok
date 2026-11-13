# DSH web server HTTP/WebSocket API — recon notes

Status: v0.2 (final for this recon task). Everything below was collected from the installed DSH
0.2.2-rc.1 desktop build (`D:\Software-2\DSH`), a self-spawned server on 127.0.0.1:3999 with a
throwaway `DSH_HOME=D:\WK_file\_ref\webhome`, and the packaged sources of the same build
(`resources\app.asar`, extracted read-only to `D:\WK_file\_ref\asar\out`). The full
prompt → streaming → tool call → approval → tool result → second step → turn/end cycle was
exercised end to end over HTTP + one WebSocket through a local OpenAI-compatible mock provider.

Evidence labels:
- VERIFIED — observed on the wire against a real `dsh web` process (fresh home, no model credentials).
- SOURCE — read from the packaged DSH sources / generated typert descriptors / companion extension code.
- INFERRED — strongly implied by SOURCE but not yet exercised live.

No secrets in this document: the launch token and cookie values printed during probing are omitted.

## 1. Spawning the server

### 1.1 Desktop install (primary path for a VS Code extension on Windows)

```
D:\Software-2\DSH\resources\runtime\cli\bin\dsh.cmd --profile web --port <N> --no-open
```
VERIFIED: `--profile web --port 3999 --no-open` produced one stdout line
`dsh web: http://127.0.0.1:3999/?token=<43-char base64url>` and an empty stderr; the flagless
composed web profile defaults to port 3080 (SOURCE, `cordis.patch.yml`).

The shim itself is only a wrapper (VERIFIED by reading it):
```
set ELECTRON_RUN_AS_NODE=1
"D:\Software-2\DSH\DeepSeek Harness.exe" --expose-internals
  "D:\Software-2\DSH\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*
```
so an extension can either spawn `cmd.exe /c "<shim>" ...` (simplest; `shell: true` on Windows) or
spawn `DeepSeek Harness.exe` directly with `env: {ELECTRON_RUN_AS_NODE: '1'}` and
`args: ['--expose-internals', '<...>\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js', '--profile','web','--port','<N>','--no-open']`.
The direct form avoids cmd.exe quoting problems and avoids the extra shim process, but hardcodes
the asar path, so resolve it relative to the discovered install root.

The documented npm form (`dsh web ...`, used by the installed companion extension for npx) is
INFERRED to be equivalent: `npx --yes @deepseek-ai/dsh@<version> web --port <N> --no-open`
(the CLI launcher maps the `web` profile; the packaged startup program is described as
`dsh --profile web`). Not executed here because it would download the package; treat
`npx` as the portability fallback and keep the version pinned.

Other CLI flags (SOURCE, `dsh-web-app/lib/startup.js`):
- `--host <host>` bind host, literal IP only; wildcard rejected. Default 127.0.0.1.
- `--port <port>`; `0` = OS picks a free port (then read the port from the printed URL).
- `--no-open` suppresses the browser launch. Without it the server also prints
  `dsh web: opening the default browser; pass --no-open to disable`.
- `--public-url <url>` advertise a different base (proxy setups).
- `--trusted-host <authority...>` repeatable; extra authorities allowed through the trust fence.
- `--tls-cert <file> --tls-key <file>` must be passed together; HTTPS then requires
  `wss://`/`https://`.

Environment: real `DSH_HOME` gives the user's credentials, settings, sessions. A separate
`DSH_HOME` gives an isolated instance (used for probing). `DSH_WEB_URL` is exported into child
shells by the web app and is the URL *without* `?token=`.

### 1.2 Readiness detection

Literal stdout line (VERIFIED):
```
dsh web: http://127.0.0.1:3999/?token=<base64url 32 random bytes, 43 chars, no padding>
```
It is printed by `dsh-web-app` once the Cordis loader settles and the HTTP+WS listeners are up, so
the line is a complete readiness signal. Parsing recipe:
`/^dsh web:\s*(https?:\/\/[^\s/]+)\/?\?token=([A-Za-z0-9_-]+)\s*$/m` → base URL + launch token.
Cold start with an empty home took ~18 s on this machine (first-run bootstrap); warm starts are
faster. Start timeout of 60 s is reasonable (the companion extension exposes `dsh.startTimeoutMs`).

Secondary HTTP probe (VERIFIED): `GET <base>/?token=<token>` answers `303` with `Location: ./`
and `Set-Cookie: dsh-auth-...`. A bare `GET <base>/` without a cookie answers `401` with body
`dsh web authentication required; reopen the URL printed by dsh web.`. Note this host runs
Windows PowerShell 5.1, where `Invoke-WebRequest` lacks `-SkipHttpErrorCheck`, so probe from Node
(global `fetch`, `redirect: 'manual'`) or `curl.exe`.

### 1.3 Shutdown and orphans

Killing the shim process does not kill the server (VERIFIED: cmd pid 29532 vs listener pid 18748).
Kill the listener pid (or `taskkill /T /F`) — remember to kill the process tree of the exact pid.
The companion extension also writes a per-pid shutdown manifest,
`%USERPROFILE%\.dsh\dsh-vscode-shutdown-manifest.json.<pid>.json`, so a restarted extension can
reap servers whose spawner died. Treat that file as extension-owned bookkeeping, not a DSH
feature. A second `dsh web` on the same port fails at bind; reuse detection must probe first.

## 2. Authentication

No `Authorization` header exists anywhere (SOURCE: `dsh-client-connection`). The only credential
is the browser cookie, minted by exchanging the launch token.

### 2.1 Token → cookie exchange (VERIFIED)

```
GET <base>/connect?token=<launchToken>&interactions=answer
→ 302 Location: ./api/remote.mux
   Set-Cookie: dsh-auth-<base64url(sha256(authority))>=v2.<b64url json>.<hmac>; Path=/; HttpOnly; SameSite=Strict; Max-Age=...
```
- `interactions` is mandatory exactly once; `answer` is required for the `$events` stream and for
  approvals (`none` is the API default and forbids forwarded events with
  `gateway/interactions-forbidden`). Repeated/malformed values → 400
  `interactions must be declared once as answer or none`.
- The cookie is authority-bound (host:port, or origin under TLS). It is accepted only on that
  exact authority — a 127.0.0.1 ↔ localhost mix is a different cookie.
- One socket owns one API peer cookie; opening a second `/connect` for the same peer answers 409.
  Closing the socket disposes the peer and later HTTP with the old cookie is refused.
- A browser gets a v1 cookie via `GET /?token=...` (303 → `./`); API clients get the v2 cookie
  bound to a client id. Only v2 authorises gateway calls.
- The signing secret lives in `$DSH_HOME\.credentials.yaml` (expected credential record). Every
  token is minted per process: it is not persisted and dies with the server.

### 2.2 Trust fence (SOURCE)

Before auth the request must pass: `Host` = loopback / bind IP literal / `--trusted-host` entry;
`sec-fetch-site: cross-site` refused; if `Origin` is present it must equal the `Host` authority.
Failures answer 403, then 401 if unauthenticated, 404 if unclaimed.

### 2.3 Extension implications

- The launch token is useful only for the process that printed it. Do not persist it in
  `SecretStorage`; a restart/every new spawn mints a new token. Store nothing (or only a
  crash-diagnostics copy that is never used as a credential).
- Send the cookie on every HTTP call and on the WS `upgrade` (Node/`ws` header). Do not send
  `Origin` from the extension; if a client insists on setting it, it must equal the base authority.
- Because the cookie lifetime is 30 days but the server-side peer is per-socket, the practical
  lifetime is the socket lifetime: reconnect by `/connect` again (token still valid) rather than
  reusing an old cookie after a socket drop.

## 3. Endpoints

Transport is JSON over `POST <base>/api/<namespace>/<method>`, body is the Connection envelope:
```json
{"type":"client-request","rpcId":"rpc-1","method":"session/list","payload":{"args":{}}}
```
Success (HTTP 200):
```json
{"type":"server-response","rpcId":"rpc-1","result":{"ok":true,"value":{}}}
```
Failure (HTTP 200 as well, inspect `ok`):
```json
{"type":"server-response","rpcId":"rpc-1","result":{"ok":false,"error":{"code":"gateway/arguments-invalid","message":"typert gateway: session/list: args fields do not match the descriptor: missing \"_request\"","details":{"endpoint":"session/list"}}}}
```
Rules (VERIFIED):
- `method` in the body must equal the URL endpoint, else `gateway/bad-request`.
- args are keyed by the descriptor parameter name, not flattened; a parameter named `request`
  means `{"args":{"request":{...}}}` (`session/prompt`, `session/create`, `session/events`), a
  `_request` means `{"args":{"_request":{...}}}` (`session/list`). Optional parameters may be
  omitted.
- `lookup` parameters are rewritten on the wire to `<name>Id` (e.g. `agent` → `agentId`); the
  lookup id is never omissible.
- HTTP-level failures: 400 body not JSON, 401 unauthorized, 403 forbidden, 404 not found,
  415 wrong content type, 500 handler failure.
- Stream endpoints (`session/follow`, `session/control`, `workspace/follow`, `$events`,
  `remoteAccess/follow`) cannot be called over HTTP:
  `gateway/signature-invalid` … `stream Remote methods must be opened through the stream carrier`.

Verified calls:

| Call | args | result |
| --- | --- | --- |
| `POST /api/session/create` | `{"request":{"cwd":"D:\\WK_file\\_ref\\webhome\\ws"}}` | `{"sessionId":"session-<uuid>","agentPreset":"standard"}` |
| `POST /api/session/prompt` | `{"request":{"requestId":"<uuid>","sessionId":"<id>","mode":"queue","content":[{"type":"text","text":"Reply with exactly: pong"}]}}` | `{"accepted":true}` |
| `POST /api/session/events` | `{"request":{"address":{"kind":"session","sessionId":"<id>"}}}` | `{"cursor":<seq>,"records":[{"type":"event","event":{...}}],"hasMore":false}` |
| `POST /api/session/list` | `{"_request":{}}` | `{"items":[{"sessionId","updatedAt","running","blank","agentAvailable","cwd","projections":{...}}]}` |
| `POST /api/session/modelCatalog` | `{}` | `{"default":{"provider","model"},"routableProviders":[],"groups":[],"failures":[]}` |
| `POST /api/agentPresets/list` | `{}` | `{"presets":[{"id":"standard","isDefault":true},...]}` |
| `POST /api/permissionPresets/catalog` | `{}` | `{"options":[...],"defaultOptions":[...],"defaultPreset":"workspace-write"}` |
| `POST /api/session/selectModel` | `{"request":{"sessionId":"<id>","provider":"mock","model":"mock-1"}}` | `{"selected":{"provider":"mock","model":"mock-1"}}` (also appends `model/selection`) |
| `POST /api/session/state` | `{"request":{"sessionId":"<id>"}}` | `{"cursor":28,"active":true,"running":false,"queue":[],"pendingInput":[]}` (`pendingInput` ∈ `approval`\|`question`\|`other`) |
| `POST /api/commands/list` | `{"agentId":"<sessionId>"}` | `[{"definitionId","name","description","input"?}]` — this build: `compact`, `export`, `feedback`, `goal`, `permission`, `plan` |
| `POST /api/commands/execute` | `{"agentId":"<sessionId>","line":"/compact","submittedAttachments":[]}` | `{"commandId":"cmd-<id>","result":{"kind":"success","text":"Compacted 6 history items (~838 tokens).","sourceEventSeq":31}}`; handler failures come back `{"kind":"error","text":"…"}` (both observed) |
| `POST /api/settings/update` | `{"ns":"llm-pi-ai","patch":{…},"expectedRevision":2}` | namespace descriptor `{ns,value,base,user,revision,…}`; stale revision is rejected |
| `POST /api/credentials/set` | `{"ref":"MOCK_API_KEY","value":"…"}` | `null` (void; value is never readable back) |
| `POST /api/credentials/describe` | `{"refs":["MOCK_API_KEY"]}` | `{"MOCK_API_KEY":{"configured":true,"source":"file","writable":true}}` |

Probe-only provider wiring used to reach the model-backed captures (VERIFIED, not needed by a real
extension): `settings/update` namespace `llm-pi-ai` with
`{"providers":{"mock":{"displayName":"Mock","api":"openai-completions","baseURL":"http://127.0.0.1:3998/v1","apiKeyEnv":"MOCK_API_KEY","models":[{"id":"mock-1","name":"Mock One","contextWindow":65536,"maxTokens":4096}]}}}`
then `credentials/set {"ref":"MOCK_API_KEY","value":"…"}`; the provider immediately appears in
`session/modelCatalog` (`groups:[{id:"mock",…}]`) and `llm/listProviders`.

Endpoint inventory found in the generated descriptors (SOURCE):

sessions and prompts
- `session/create` request `{sessionId?, workspaceId?, cwd?, agentPreset?}` → created session,
  reusing a blank named session when possible; errors `session/conflict`,
  `session/writer-held`, `session/model-unavailable`.
- `session/list` `_request {cursor?}` → page of session summaries with projections.
- `session/prompt` request `{requestId, sessionId, mode:'queue'|'steer', content:[...],
  clientTimeZone?}` → `{accepted:true}`. `requestId` is idempotent: a retried prompt with the same
  id returns the original acceptance instead of double-queueing. Content blocks: text
  (`{type:'text',text}`), image (`{type:'image',mediaType,data}`), file receipt
  (`{type:'file',receiptId}`). `mode:'queue'` appends a transcript turn; `'steer'` injects into the
  running turn.
- `session/cancel` request `{sessionId}` → `{accepted:true}` (SOURCE; live verification pending).
- `session/rename` `{sessionId,title}`; `session/fork`; `session/attachment`;
  `session/updateQueue` `{sessionId,itemId,action:{kind:'edit'|'remove'|'steer'}}`.
- `session/events` request `{address:{kind:'session',sessionId}|{kind:'subagent',
  parentSessionId,childSessionId,mode}, throughSeq?, beforeSeq?, maxMessages?, turnWindow?}` →
  `{cursor, records:[{type:'event',event:{type,seq,time,data,surfaceOp?}}], hasMore}`.
- `session/follow` (stream) request `{address, activate?, assistantStream?, maxMessages?,
  turnWindow?}`: first item a `snapshot`, then `event` frames (see §4).
- `session/modelCatalog`; `session/selectModel` request `{sessionId,provider,model,
  reasoningEffort?}`; `session/initializeDefaultModel`; `session/state`/`session/wait`;
  `session/search`; `session/projections`, `session/observeProjections`, `session/observeEvent`,
  `session/control` (stream of projection frames); `session/canOpenWorkspacePath`,
  `session/openWorkspacePath`, `session/workspacePathApplications`.
- `skills/list`, `fileReferences/list {agentId}`.

workspace, settings, credentials
- `workspace/create {path?}`, `workspace/delete`, `workspace/rename`, `workspace/insertBefore`,
  `workspace/insertSessionBefore`, `workspace/pinSession`, `workspace/unpinSession`,
  `workspace/archiveSession`, `workspace/unarchiveSession`, `workspace/initializeDefault`,
  `workspace/follow` (stream). Workspace item: `{workspaceId,path,title,sessionIds,createdAt,
  updatedAt}`.
- `settings/describe` → `{writable,hasDocument,namespaces:[{ns,schema,value,base,user,secrets,
  revision}]}` (21 namespaces on this build: `agent-default-model`, `permission`, `llm-deepseek`,
  `llm-pi-ai`, `agent-loop`, `subagent`, `web`, `ui-*`, `locale`, `agent-preset-registry`,
  `pwsh-sandbox`, `web-search-deepseek`, ...).
- `settings/update {ns,patch,expectedRevision}`, `settings/replace`, `settings/mutate`,
  `settings/openSettingsDocument`; `credentials/describe|set|unset`.
- `commands/list {agentId}`, `commands/execute {agentId,line,submittedAttachments}`
  (SOURCE: companion extension; the lookup id is the session id).
- `agentPresets/list`, `agentPresets/read`, `agentPresets/select {agentId,agentPreset}`.
- `permissionPresets/catalog`; current preset rides the session event log
  (`permission/preset`, §4).
- `llm/listProviders`, `llm/listConfigurableProviders`, `llm/discoverModels`.
- `directoryPicker/pick|list|createDirectory`; `remoteAccess/follow`.

## 4. Streaming: WebSocket mux and event payloads

### 4.1 WS mux protocol

One socket: `ws://<host>:<port>/api/remote.mux` (legacy `0.1.x`: `/api/events.mux`), opened with
the auth cookie header (no token query). All logical streams are multiplexed:

client → server
```json
{"type":"open","streamId":"<uuid>","endpoint":"$events","payload":{"args":{}}}
{"type":"open","streamId":"<uuid>","endpoint":"session/follow","payload":{"args":{"request":{"address":{"kind":"session","sessionId":"<id>"}}}}}
{"type":"cancel","streamId":"<uuid>"}
{"type":"end","streamId":"<uuid>"}
```
server → client (VERIFIED for `$events` and `session/follow`)
```json
{"type":"item","streamId":"<uuid>","value":{"type":"ready","clientId":"<uuid>","host":{"home":"C:\\Users\\aaa_w"}}}
{"type":"item","streamId":"<uuid>","value":{"type":"emit","event":"api-session/added","args":[...]}}
{"type":"item","streamId":"<uuid>","value":{"type":"snapshot","header":{...},"projections":{...}}}
{"type":"item","streamId":"<uuid>","value":{"type":"event","event":{"type":"turn/start","seq":4,"time":1763016800000,"data":{"turn":1}}}}
```
Frames the Host may send for forwarded events are one of `ready` | `emit` | `waterfall` |
`cancel` (SOURCE, `parseRemoteEventFrame`). Ping/pong heartbeat every 2 s; two missed intervals
terminate the socket. permessage-deflate is on by default.

`$events` is the internal forwarded-event stream: `{"type":"open","streamId":"<id>",
"endpoint":"$events","payload":{"args":{}}}`. The first item is `ready` and carries `clientId`
and `host.home`. Afterwards `emit` frames are the session-list/status notifications and
`waterfall` frames are interactive requests (approvals) that must be answered over HTTP (§4.4).

`session/follow` first item (VERIFIED):
```json
{"type":"snapshot",
 "header":{"version":4,"id":"session-<uuid>","createdAt":1763016800000,"cwd":"D:\\...","isSeeded":false,"agentPreset":"standard"},
 "projections":{"asOfSeq":2,
  "values":{"sessionStats":{"turns":0,"steps":0,"llmMs":0,"toolMs":0,"ttftMs":0,"ttftSteps":0,"decodeMs":0,"decodeTokens":0},
            "turnOutline":[],"userQuestions":{"active":[],"settled":[]},
            "tokenUsage":{"uncachedInputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0}}}}
```
subsequent items: `{"type":"item","streamId":"<id>","value":{"type":"event","event":<SessionWireEvent>}}`.
The opening snapshot also carries the full projection set, useful to render a session instantly
(VERIFIED keys): `sessionStats`, `turnOutline` (`[{turn,seq,prompt,response}]`), `userQuestions`,
`tokenUsage`, `contextPressure`, `title`, `goal`, `agentPreset`, `modelSelection`
(`{lastUsed,next}`), `workingDirectory`, `contextBreakdown`, `inbox` (`next-turn`/`next-step`),
`permissions.currentValue`, `subagentCatalog`, `todos`, `plan` (`{active,pending}`),
`sessionListMetadata`, `imageLimits`.

`session/control` (VERIFIED, opened with EMPTY args `{}` — it takes no parameters) is the cheapest
way to hydrate every session at connect: its first item is
```json
{"type":"item","streamId":"<id>","value":{"type":"baseline","value":{
  "projections":{"session-<uuid>":{"asOfSeq":18,"values":{ … same projection set as above … }}, "session-<other>":{…}}}}}
```
followed by replacement frames for the same map. `workspace/follow` (`args:{}`) yields a
`baseline` with `{items:[{workspaceId,path,title,sessionIds,createdAt,updatedAt}],
archivedSessionIds, pinnedSessionIds}`, then `upsert` | `remove` | `order` | `archived` | `pinned` |
`replace` increments (baseline/upsert/order/archived/pinned VERIFIED in the companion extension's
mock; the remaining variants are SOURCE descriptor schemas).

One cookie authorises exactly one mux socket at a time (VERIFIED): opening a second socket while
the first is alive answers HTTP 409 on the upgrade, and once the first socket closes, reusing the
same cookie answers 401 — call `/connect` again for every new socket.

### 4.2 Session event log (VERIFIED capture, no model credentials)

Real 19-record capture from `session/events` after one `session/prompt` (fresh home → the model
call fails; shapes below are real, long strings truncated):

```
0  permission/preset   {"preset":"workspace-write"}
1  sandbox/mode        {"mode":"workspace-write"}
2  approval/policy     {"policy":"ask"}
3  agent/inbox/spliced {"target":"next-turn","start":0,"inserted":[{"content":[{"type":"text","text":"Reply with exactly: pong"}],"source":{"kind":"user","rpcId":"rpc-…"},"role":"user","id":"<uuid>"}]}
4  turn/start          {"turn":1}
5  agent/inbox/spliced {"target":"next-turn","start":0,"removedCount":1,"inserted":[]}
6  step/start          {"turn":1,"step":1}
7  system/message      {"turn":1,"step":1,"message":{"role":"system","content":[{"type":"text","text":"…"}]}}
8  user/message        {"content":[{"type":"text","text":"Reply with exactly: pong"}],"…"}   (surfaceOp:"append")
9  user/message        runtime-context block (source.kind "runtime-context")
10 user/message        skills system-reminder block
11 user/message        time-context block (source.kind "time-context")
12 request/header      {"header":{"config":{"provider":"deepseek-official","model":"deepseek-flash","maxTokens":256000,"reasoningEffort":"high"},"adapterDefaults":{"reasoningEffort":true,"maxTokens":true},"tools":[…names…]}}
13 request/context     {"provider":"deepseek-official","model":"deepseek-flash","contextWindow":1048576,"systemPromptUpdate":"in-history"}
14 session/title       {"title":"…","messageSeqs":[8],"source":{"kind":"fallback"}}
15 session/title-llm-request {"titleProvider":…,"messageSeqs":[8],"route":{"provider":…,"model":…},"system":…}
16 assistant/attempt   {"turn":1,"step":1,"stream":[{"type":"chunk","time":…,"chunk":{"type":"finish","reason":{"kind":"error","failure":{"message":"llm-deepseek: no API key for provider route \"deepseek-official\"; store DEEPSEEK_API_KEY …"}}}}]}
17 step/end            {"turn":1,"step":1}
18 turn/end            {"turn":1,"reason":{"kind":"error","error":{"message":"…","code":"MISSING_CREDENTIAL"}}}
```
### 4.2b Verified model-backed cycle (mock OpenAI-compatible provider)

To reach the assistant/tool/approval shapes without the user's real credentials, a local
OpenAI-compatible SSE endpoint was registered as a custom provider through the settings API
(VERIFIED, recipe below), then one `session/prompt` produced the full cycle. Event order from
`session/events`:

```
permission/preset, sandbox/mode, approval/policy, model/selection, agent/inbox/spliced,
turn/start, agent/inbox/spliced, step/start, system/message, user/message ×4,
request/header, request/context, session/title, session/title-llm-request,
assistant/message, tool/call, approval/asked, approval/decided,
job/registered, job/settled, tool/result, step/end,
step/start, assistant/message, step/end, turn/end
```

Real payloads (truncated; VERIFIED):
```json
{"type":"assistant/message","seq":17,"data":{"turn":1,"step":1,
 "message":{"role":"assistant","content":[
   {"type":"reasoning","text":"The user wants the pwsh tool used. "},
   {"type":"text","text":"I will write a probe file with pwsh. Calling the tool now."},
   {"type":"tool-call","id":"call_mock_1","name":"pwsh","arguments":"{\"command\":\"Get-ChildItem …\",\"description\":\"…\",\"sandbox_permissions\":\"danger-full-access\",\"justification\":\"…\"}"}],
   "source":{"kind":"model","provider":"mock","model":"mock-1","replayState":{…},"id":"<uuid>"}},
 "usage":{"inputTokens":100,"outputTokens":20,"totalTokens":120}}}
{"type":"tool/call","seq":18,"data":{"turn":1,"step":1,"callId":"call_mock_1","name":"pwsh","arguments":"{…}"}}
{"type":"tool/result","seq":23,"data":{"turn":1,"step":1,
 "message":{"role":"tool","source":{"kind":"tool","callId":"call_mock_1"},"toolCallId":"call_mock_1",
            "content":[{"type":"text","text":"\r\n\r\n    目录: C:\\Users\\aaa_w\r\n…"}],
            "isError":false,"id":"<uuid>"},
 "meta":{"cwd":"D:\\WK_file\\_ref\\webhome\\ws"},"sourceEventSeqs":[18],"surfaceOp":"append"}}
{"type":"turn/end","seq":28,"data":{"turn":1,"reason":{"kind":"completed"}}}
```
`turn/end.reason` variants observed: `{"kind":"completed"}`, `{"kind":"error","error":{"message":"…","code":"MISSING_CREDENTIAL"}}`.
`job/registered` and `job/settled` wrap local tool execution (presence VERIFIED, payload not logged).
A failed tool is still a normal `tool/result` with `"isError":true` and the failure text in
`message.content[0].text` — e.g. `"Error: invalid escalation: sandbox_permissions requires a
justification"`, or the raw `[stderr] …` output of the command.

### 4.2c Assistant live stream (`assistantStream:true`) — VERIFIED

`session/follow` opened with `assistantStream:true` emits, interleaved with `event` items, items
whose `value.type` is `"assistant-stream"` and whose `value.frame` is one of:

```json
{"type":"start","attemptId":"session-<uuid>:1","revision":1,"turn":1,"step":1,"startedAfterSeq":14}
{"type":"chunk","attemptId":"session-<uuid>:1","revision":2,"index":0,"time":1763016800000,
 "chunk":{"type":"block-start","index":0,"blockType":"reasoning"}}   // blockType reasoning|text|tool-call
{"type":"chunk",…,"chunk":{"type":"reasoning-delta","index":0,"text":"The user wants … "}}
{"type":"chunk",…,"chunk":{"type":"text-delta","index":1,"text":"I will write a probe file … "}}
{"type":"chunk",…,"chunk":{"type":"tool-call-delta","index":2,"id":"call_mock_1","name":"pwsh",
                          "argumentsDelta":"{\"command\":\"…\",\"description\":\"…\"}"}}
{"type":"chunk",…,"chunk":{"type":"block-end","index":0,"block":{"type":"reasoning","text":"…"}}}
{"type":"chunk",…,"chunk":{"type":"block-end","index":2,"block":{"type":"tool-call","id":"call_mock_1",
                          "name":"pwsh","arguments":"{…}"}}}
{"type":"chunk",…,"chunk":{"type":"usage","usage":{"inputTokens":100,"outputTokens":20,"totalTokens":120}}}
{"type":"chunk",…,"chunk":{"type":"finish","reason":{"kind":"tool-calls"},
 "replayState":{"response":{"kind":"pi-ai","version":2,"api":"openai-completions","provider":"mock",
   "model":"mock-1","responseId":"chatcmpl-mock","stopReason":"toolUse"},"blocks":[…]}}}
{"type":"end","attemptId":"session-<uuid>:1","revision":15,"index":13,
 "outcome":{"kind":"committed","eventType":"assistant/message","seq":17}}
```
Every frame carries `attemptId` (new attempt per model step, `session-<uuid>:<step>`), `revision`
(monotonic within the attempt) and `index` (frame counter). `finish.reason.kind` ∈
`tool-calls` | `stop` | `error` (`error` carries `failure:{message,code}`). The renderer can append
deltas per block and reconcile with the committed `assistant/message` event; `end.outcome` links
the attempt to the committed event (`kind:"committed"`, `seq`).

Known event vocabulary on the wire (session log): `turn/start`, `turn/end`, `step/start`,
`step/end`, `system/message`, `user/message`, `assistant/message`, `assistant/attempt`,
`assistant/chunk` (assistantStream), `tool/call`, `tool/result`, `job/registered`, `job/settled`,
`todo/*`, `subagent/*`, `approval/policy`, `approval/asked`, `approval/decided`,
`permission/preset`, `sandbox/mode`, `request/header`, `request/context`, `session/title`,
`session/title-llm-request`, `model/selection`, `question/*`, plus the assistant live baseline
`{startedAfterSeq,nextIndex,compactStream}` carried by `session/follow` (§4.3).

### 4.3 `$events` notifications (VERIFIED)

`api-session/added` args = one session record:
```json
[{"sessionId":"session-<uuid>","updatedAt":1763016800000,"agentAvailable":true,
  "formatStatus":"current","running":false,"blank":true,"cwd":"D:\\…",
  "projections":{"kind":"sequenced","asOfSeq":2,"values":{}}}]
```
`api-session/status` args `["session-<uuid>", false]` (running flag),
`api-session/activity` args `["session-<uuid>", 1763016800000]`,
`api-session/error` args `["session-<uuid>", "<message>"]`.

### 4.4 Approvals — VERIFIED (live capture)

When the policy is `ask` and the model requests sandbox escalation (tool-call argument
`sandbox_permissions`, which requires the extra argument `justification`), DSH appends
`approval/asked` and forwards a `waterfall` frame on `$events`:
```json
{"type":"item","streamId":"<eventsStreamId>","value":{
  "type":"waterfall","event":"approval/request","eventId":"<id>","agentId":"<sessionId or agent>",
  "request":{"toolName":"pwsh","callId":"call_mock_1",
             "reason":"escalate sandbox to danger-full-access: <justification>",
             "displayReason":{"en":"Allow this operation with danger-full-access permissions: …",
                              "zh":"允许本次操作使用 danger-full-access 权限：…",
                              "ja":"…","es":"…","fr":"…","de":"…","ru":"…","pt":"…"}}}}
```
The client answers over HTTP with the `clientId` from the `$events` `ready` frame and the frame's
`eventId` (VERIFIED: returns `{"ok":true,"value":null}`; the host then appends `approval/decided`
and continues the step):
```
POST /api/$events/result
{"type":"client-request","rpcId":"…","method":"$events/result",
 "payload":{"args":{"clientId":"<ready.clientId>","eventId":"<eventId>",
                    "outcome":{"kind":"result","value":"allowed-once"}}}}
```
Log records produced (VERIFIED):
```json
{"type":"approval/asked","seq":19,"data":{"id":"<uuid>","toolName":"pwsh","callId":"call_mock_1","reason":"escalate sandbox to danger-full-access: …"}}
{"type":"approval/decided","seq":20,"data":{"id":"<same uuid>","outcome":"allowed-once"}}
```
Decision vocabulary (SOURCE, `dsh-client-ui-approval`): `allowed-once`, `rejected`, plus an
"always" variant; `outcome.kind` is `result` | `next` | `rejected` (rejected carries a projected
error). A wrong peer answers `gateway/interactions-forbidden` `Remote event result belongs to
another Peer`. `question/request` uses the same waterfall transport with its own `request` shape
(INFERRED, not exercised). Session policy comes from the session event
`approval/policy {policy:'ask'|'never'}` (switchable via the `permission` command or the
`permissionPresets` settings); `never` suppresses the prompt and gated actions fail closed.
A plain sandbox-denied tool that does not request escalation does NOT raise an approval — it is a
normal `tool/result` with `isError:true` (VERIFIED).

### 4.5 Cancel / abort

- HTTP: `POST /api/session/cancel` with `{"args":{"request":{"sessionId":"<id>"}}}` → descriptor
  says `{accepted:true}` (descriptor-VERIFIED, HTTP path verified on the same controller; the live
  aborted-turn capture is owned by the web-backend track).
- Stream: closing a logical stream is `{"type":"cancel","streamId":"<id>"}`; the Host may also
  send `{"type":"cancel","eventId":"<id>"}` for a forwarded interaction.
- A queued item can be withdrawn/edited with `session/updateQueue`
  `{sessionId,itemId,action:{kind:'edit'|'remove'|'steer'}}`; the prompt's `requestId` remains
  the idempotency handle for retry after a transport drop.

## 5. Minimal TypeScript client flow

1. Spawn: `dsh.cmd --profile web --port 0 --no-open` (or `--port <free port>`), capture stdout.
2. Ready: wait for `^dsh web: (http\S+) \?token=(\S+)$`; `base`, `token`. Timeout 60 s.
3. Auth: `GET ${base}/connect?token=${token}&interactions=answer` with `redirect:'manual'`;
   read `set-cookie` → `cookie` (no `Origin` header).
4. Open WS `${base.replace('http','ws')}/api/remote.mux` with `headers:{cookie}`.
5. `open $events` on the mux; wait for `ready`, keep `clientId`; then `session/create`
   `{request:{cwd}}` and `open session/follow` with that sessionId.
6. Send: `POST ${base}/api/session/prompt` `{args:{request:{requestId,sessionId,mode:'queue',
   content:[{type:'text',text}]}}}`.
7. Render from `session/follow` `event` frames (`turn/start`, `assistant/chunk`, `tool/call`, …);
   also incremental-poll `session/events` for resume.
8. Approve: on `waterfall` frame `approval/request` → `POST /api/$events/result` with
   `clientId`+`eventId`+`outcome`; or pre-set policy via `settings/update` namespace `permission`.
9. Stop: `POST /api/session/cancel`; disconnect the WS; kill the spawned process tree (or leave it
   running for reuse and record it in a manifest).

Pitfalls:
- CORS irrelevant (no browser), but the trust fence is real: send no `Origin`, keep the cookie
  bound to the exact authority. Browsers need the `--trusted-host` flag only for non-loopback.
- One server per window vs one global: every spawn mints a new token and a new process; reusing
  one server across windows means sharing the session store (DSH_HOME) and one cookie peer per
  socket — a second socket for the same peer answers 409 on `/connect`, so each window needs its
  own `/connect` cookie.
- `session/create` binds the cwd; a prompt runs tools relative to it. Re-opening an existing
  session (`session/list` → `sessionId`) is how resume works; a prompt against a session that is
  live elsewhere may answer `session/writer-held` or `session/agent-busy`.
- Model availability: `session/modelCatalog` may return empty `groups` when credentials are
  missing; surface this instead of failing silently.
- The launch line is the sole readiness oracle: do not probe `/` before it (401/ECONNREFUSED).

## 6. Version fragility

Installed build: DSH `0.2.2-rc.1` (desktop `D:\Software-2\DSH`, CLI shim
`D:\Software-2\DSH\resources\runtime\cli\bin\dsh.cmd --version`).

- 0.1.x used dotted endpoints (`/api/session.list`, `/api/commands.execute` style) and the
  `/api/events.mux` socket; 0.2.x uses `/api/<ns>/<method>` and `/api/remote.mux`. The companion
  extension switches on a capability probe and only falls back to legacy for pre-`0.1.2-alpha.1`.
- The generated typert descriptors (`lib/typert.remote-client.js` inside the asar) are the
  authoritative schema for a given build; parse or fixture them at development time instead of
  hardcoding shapes, and gate on `--version` plus a smoke call (`session/list` with
  `{"_request":{}}`) at runtime.
- Descriptor drift is loud, not silent: missing/extra args produce
  `gateway/arguments-invalid` with exact field names.
- The npm fallback must pin a version (`@deepseek-ai/dsh@<x.y.z>`); an unpinned `npx` resolves a
  newer build whose schemas may differ.
- Detection strategy: run `dsh --version` (cheap) → pick endpoint style → probe `session/list`.
  Treat a failed smoke probe as "unsupported build", do not retry with legacy shapes blindly.

## 7. Verdict (GO)

- GO for a native HTTP+WS backend: the complete UX path was verified end to end on this build —
  spawn → token/cookie → `$events` ready → `session/create` → `session/prompt` → assistant stream
  frames → tool call → approval waterfall + `$events/result` → tool result → `turn/end`, plus
  sessions list/events/state, models, presets, commands, settings and credentials.
- Cost: no official client SDK on this path; you re-implement the typert envelopes and must
  tolerate version drift. Auth is a per-process throwaway token/cookie and one cookie per socket,
  so the extension must manage the process and reconnect lifecycle itself.
- Alternative (SDK stdio): stable typed surface but requires an SDK package and a duplex stdio
  transport; no web UI reuse, no `/api/file` asset serving, and streaming shapes are the SDK's,
  not the mux's.
- Recommendation: adopt the web API for the VS Code chat backend behind a thin transport adapter
  (spawn+readiness+cookie+envelope+mux), keep the SDK stdio path as fallback where the smoke probe
  (`session/list` with `{"_request":{}}`) fails.

TODO — remaining gaps (everything else in this doc is VERIFIED on the wire)
- Live aborted-turn capture for `session/cancel` (descriptor and HTTP path are verified; the
  aborted `turn/end` reason variant is not captured here — the web-backend track owns it).
- `dsh.cmd web` positional form (vs `--profile web`) and `--port 0` — not exercised; the
  `?token=` line remains the readiness oracle either way.
- Adopting an externally spawned server via `DSH_WEB_URL`: the env var carries the URL WITHOUT the
  token, and the token is only printed to that server's stdout, so adoption works only when the
  same extension spawned (and captured) the process; otherwise the launch token cannot be
  recovered. Launch your own instance for a native backend.
- `question/request` waterfall `request` shape and `todo/*`, `subagent/*` event payloads: SOURCE
  vocabulary only; no live capture on this build.
