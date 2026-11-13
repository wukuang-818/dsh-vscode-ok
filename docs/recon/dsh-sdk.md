# DSH SDK stdio backend for the VS Code extension — recon report

Machine: Windows, workspace `D:\WK_file\dsh-vscode-ok`, desktop DSH `0.2.2-rc.1` installed at
`D:\Software-2\DSH`. All results below were produced by spawning the installed runtime and
talking newline-delimited JSON-RPC over stdio. Scratch harness and raw logs:
`D:\WK_file\_ref\sdk-test\` (`raw.mjs`, scenario scripts, `logs/*.jsonl`). No repo code was
modified and no secrets were printed.

## 1. Verdict

GO for `dsh --profile sdk` as the extension backend on this install, with three caveats that
must shape the UI and the process lifecycle:

1. There is no token-level streaming. All text/reasoning/tool-call deltas for a step arrive
   inside the single `assistant/message` session event at the end of that step, in
   `data.stream[]` (`text-chunks`/`reasoning-chunks`/`tool-call-chunks` with per-chunk `dt`
   arrays). A UI can replay the typing animation from those arrays, but cannot show tokens as
   they are generated.
2. There is no wire-level cancel. Abort must be implemented by closing or killing the runtime
   process. Graceful path: `shutdown` request, then stdin EOF, then `SIGTERM`, then `SIGKILL`.
3. Session resume across restarts requires `session/resume` (not a prompt on the old id) and
   the same `DSH_HOME` persistence store. Prompts on an already-persisted-but-not-open id fail
   with `session "<id>" already exists`.

Against the HTTP web API: the stdio SDK costs more client code (transport, approval bridge,
question bridge, process lifecycle) but gives one private runtime per workspace, no port
ownership or CORS problem, no dependence on the desktop GUI being the server, and the same
managed login. The web API currently running on `127.0.0.1:54276` is a shared desktop-global
surface; using it from an extension means depending on that app's URL, its auth, and its
lifecycle. For a VS Code extension, stdio is the cleaner process boundary; the tradeoff is
that every spawned runtime is a full ~200 MB Electron process and a fresh `DSH_HOME` can fail
to start until profile packages are installed (section 10). If the extension must not ship a
200 MB runtime dependency, the web API remains the fallback, at the cost of coupling to the
desktop app and its port.

Published protocol npm package `@deepseek-ai/dsh-sdk-protocol@0.0.1-rc.1` is older than the
installed server. The installed server is `0.2.2-rc.1` and exposes more methods and two
server-to-client requests (approvals, user questions) that the 0.0.1 client types do not know.
Implement against the wire as documented here, not only against the 0.0.1 d.ts.

## 2. Exact launch invocation

The desktop's CLI shim `D:\Software-2\DSH\resources\runtime\cli\bin\dsh.cmd` sets
`ELECTRON_RUN_AS_NODE=1` and execs:

```
"D:\Software-2\DSH\DeepSeek Harness.exe" --expose-internals
  "D:\Software-2\DSH\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*
```

For the extension, spawn the exe directly (no `cmd.exe` layer, so one PID to manage):

```
exe  = D:\Software-2\DSH\DeepSeek Harness.exe
args = --expose-internals
       D:\Software-2\DSH\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js
       --profile sdk
env  = { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
cwd  = <workspace folder>          // becomes the sandbox workspaceRoot
stdio = pipe / pipe / pipe
```

Node reference (verified working):

```js
const child = spawn(exe, ['--expose-internals', cliJs, '--profile', 'sdk'], {
  cwd: workspaceFolder,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
```

- `ELECTRON_RUN_AS_NODE=1` is mandatory; without it the .exe starts the desktop GUI.
- `--profile sdk` is required; the default profile is the desktop/web app and does not serve
  JSON-RPC on stdio.
- Do not put the shim (`dsh.cmd`) in the chain if you want a clean kill; `cmd.exe` becomes the
  parent and killing it can orphan the Electron child.
- `--profile sdk` auto-creates `%DSH_HOME%\profiles\sdk` on first run with
  `package.json` declaring bundles `["@deepseek-ai/dsh-base","@deepseek-ai/dsh-sdk-app"]`.
  `dsh --profile sdk --dump-config` prints the composed 438-line tree in ~350 ms and is a
  fast way to debug plugin activation from the extension's diagnostic command.

Environment that works on this machine without extra setup: inherited env plus
`ELECTRON_RUN_AS_NODE=1`. `DSH_HOME` resolves to `C:\Users\aaa_w\.dsh`; `DEEPSEEK_API_KEY` is
absent and is not needed (managed credentials in `%DSH_HOME%\.credentials.yaml`). Startup logs
on stderr mention a model listing from `https://api.deepseek.com/models`; stdout stays pure
JSON.

## 3. Handshake

Framing: one compact JSON object per line, JSON-RPC 2.0. Every observed stdout line parsed as
JSON (`nonJsonStdoutCount: 0` in all scenarios). Map request ids; notifications have no id.
Both server->client requests and notifications must be dispatched on `method`.

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
  "cwd":"D:\\WK_file\\_ref\\sdk-test\\workspace",
  "provider":"deepseek-official",
  "model":"deepseek-flash",
  "maxTokens":1024,
  "reasoningEffort":"high",
  "approvalRequests":true,
  "capabilities":{"userQuestions":true}}}
```

```json
{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"deepseek-harness-sdk-runtime","version":"0.0.1"}}}
```

Timing: spawn -> initialize response 1.3 s in warm runs (~2.9 s from spawn in the first run,
which included a model-catalog fetch; the client should allow 60 s). `maxTokens` is enforced
per step: a 512 cap produced `finish.reason.kind:"max-tokens"` and truncated text.

`initialize` does not validate the model string: an unknown model was accepted and the prompt
was accepted too (error surfaces later, at the model request). An unknown provider fails
immediately in ~1 s:

```json
{"jsonrpc":"2.0","id":1,"error":{"code":-32603,
 "message":"no adapter registered for provider \"not-a-provider\""}}
```

A missing `cwd` fails with
`{"code":-32603,"message":"The \"paths[0]\" argument must be of type string. Received undefined"}`.
A relative `cwd` is accepted (resolved against the runtime process cwd) but should not be used:
pass an absolute workspace path.

`reasoningEffort` is optional and adapter-owned; omitted keeps the model default. Both
`approvalRequests` and `capabilities.userQuestions` default to false.

## 4. Turn loop

`session/prompt` is a low-level enqueue. It never routes slash commands and returns a durable
receipt, not a model result:

```json
{"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{
  "sessionId":"6a261486-8d71-47de-b506-1e5ce3b521e5",
  "contentBlocks":[{"type":"text","text":"Reply with exactly the word pong and nothing else."}]}}
```

```json
{"jsonrpc":"2.0","id":2,"result":{"messageId":"6e9d3fb5-cd98-4351-92ec-50fa1f6e479b"}}
```

Receipt latency 18 ms. An unknown `sessionId` lazily creates the session; the first event is
`permission/preset` with `seq:0`. There is no `session/close`; a session lives until the
process exits (and is persisted via JSONL if persistence is on).

Completion: wait for `session.event` with `event.type === "turn/end"` for the session, then
treat the following `session.status {status:"idle"}` as optional confirmation. Waiting on
`idle` alone is racy because a previous turn's idle notification can arrive after the next
prompt was sent. `turn/end.data.reason.kind` is `completed`, `max-tokens`, or `error`
(with `reason.error.message`/`code`). Observed timings: warm prompt->turn/end 0.75-1.1 s for a
one-word reply, 2.6 s for a two-tool turn, 4.3 s for a 512-token `/help` ordinary prompt, 6.0 s
for an AGENTS.md answer, 6.1 s for `/compact`.

Full event sequence for one simple turn (all are `session.event` notifications unless marked):

```
permission/preset   {preset:"workspace-write"}          seq 0
sandbox/mode        {mode:"workspace-write"}            seq 1
approval/policy     {policy:"ask"}                      seq 2
agent/inbox/spliced {target:"next-turn",start:0,inserted:[UserMessage]}   seq 3
turn/start          {turn:1}                            seq 4
agent/inbox/spliced {target:"next-turn",start:0,removedCount:1,inserted:[]}  seq 5
step/start          {turn:1,step:1}                     seq 6
system/message      {message:{role:"system",content:[{type:"text",text:"You are an AI agent powered by DeepSeek Harness...."}]}}
user/message        {content:[{type:"text",text:<prompt>}],source:{kind:"user"},role:"user",id:<messageId>} surfaceOp:"append"
user/message         5 injected context messages: ~/.dsh/AGENTS.md reminder, runtime context, skills catalog, time context
request/header      {config:{...},adapterDefaults:{reasoningEffort:true},tools:[<30 schemas>]}
request/context     {provider,model,contextWindow:1048576,systemPromptUpdate:"in-history"}
session/title       {title:"<fallback title>",messageSeqs:[8],source:{kind:"fallback"}}
session-log-deepseek/delivery-accepted {sessionFormatVersion:4,throughSeq:15}
assistant/message   {turn,step,message:{content:[reasoning,text]},usage,stream:[...]}
step/end            {turn:1,step:1}
turn/end            {turn:1,reason:{kind:"completed"}}
session.status      {sessionId,status:"idle"}   <- separate notification method
```

Other event types seen: `assistant/attempt` (step failed, e.g. unsupported content),
`tool/call`, `job/registered`, `job/settled`, `tool/result`, `session/title`, `turn/end` with
`reason.kind:"error"`. Session events are emitted for every session owned by the runtime,
unfiltered: if the extension multiplexes several sessions, filter by `sessionId`.

### Session events sample (verbatim, truncated)

```json
{"type":"permission/preset","seq":0,"time":1794556308381,"data":{"preset":"workspace-write"}}
{"type":"sandbox/mode","seq":1,"data":{"mode":"workspace-write"}}
{"type":"approval/policy","seq":2,"data":{"policy":"ask"}}
{"type":"turn/start","seq":4,"data":{"turn":1}}
{"type":"turn/end","seq":19,"data":{"turn":1,"reason":{"kind":"completed"}}}
{"type":"turn/end","seq":17,"data":{"turn":1,"reason":{"kind":"error","error":{
  "message":"DeepSeek Messages cannot represent user/tool-result content bogus",
  "code":"UNSUPPORTED_CONTENT"}}}}
```

### assistant/message and the embedded stream

```json
{"type":"assistant/message","seq":17,"time":1794556309143,"data":{
 "turn":1,"step":1,
 "message":{"role":"assistant",
  "content":[{"type":"reasoning","text":"The user wants exactly \"pong\". ..."},
             {"type":"text","text":"pong"}],
  "source":{"kind":"model","provider":"deepseek-official","model":"deepseek-flash",
            "replayState":{"response":{"kind":"deepseek-messages","version":1,"model":"deepseek-flash"},
                           "blocks":[{"type":"reasoning","signature":"2381c287-..."},{"type":"text"}]}},
  "id":"2a2eb252-8ffd-42cc-ac71-3a9493914abb"},
 "usage":{"inputTokens":10360,"outputTokens":51,"cacheReadTokens":0,"cacheWriteTokens":0,"totalTokens":10411},
 "stream":[
  {"type":"chunk","time":...,"chunk":{"type":"block-start","index":0,"blockType":"reasoning"}},
  {"type":"reasoning-chunks","time0":...,"index":0,"dt":[117,0,10,...],"texts":["The"," user"," wants", ...]},
  {"type":"chunk","chunk":{"type":"block-end","index":0,"block":{"type":"reasoning","text":"..."}}},
  {"type":"chunk","chunk":{"type":"block-start","index":1,"blockType":"text"}},
  {"type":"text-chunks","time0":...,"index":1,"dt":[0],"texts":["p","ong"]},
  {"type":"chunk","chunk":{"type":"block-end","index":1,"block":{"type":"text","text":"pong"}}},
  {"type":"chunk","chunk":{"type":"usage","usage":{"inputTokens":10360,"outputTokens":51,"cacheReadTokens":0,"cacheWriteTokens":0,"totalTokens":10411}}},
  {"type":"chunk","chunk":{"type":"finish","reason":{"kind":"stop"},"replayState":{...}}}]},
 "surfaceOp":"append"}
```

`usage` is cumulative for the turn step. `inputTokens` 10360 on a first one-word turn reflects
system prompt + 30 tool schemas + injected workspace context; later turns showed cache hits
(`cacheReadTokens` 8320-11008). The `stream[]` `dt` values are milliseconds between chunks, so
a UI can reconstruct typing cadence exactly.

### Tool call / result events (2-step turn, `pwsh` + `write`)

`assistant/message` content for step 1 includes tool-call blocks whose `arguments` is a JSON
string (not an object):

```json
{"type":"tool-call","id":"call_00_ET_...","name":"pwsh",
 "arguments":"{\"command\": \"Write-Output TOOL_PROBE_OK\", \"description\": \"Output probe string\"}"}
```

`stream[]` carries `{"type":"tool-call-chunks","time0":...,"index":2,"dt":[...],"id":"call_00_...","name":"pwsh","args":["{","\"","command","\"",...]}`.
Per-tool events:

```json
{"type":"tool/call","seq":...,"data":{"turn":1,"step":1,"callId":"call_00_...","name":"pwsh","arguments":"{\"command\": ...}"}}
{"type":"job/registered","data":{"jobId":"pwsh-097d7a7a703948fa","owner":"<sessionId>","kind":"pwsh","label":"...","startedAt":...,"toolCall":{"callId":"call_00_...","rootCallId":"call_00_..."}}}
{"type":"job/settled","data":{"status":"completed","cause":"producer","producerReported":true,"detail":"exit code: 0","finishedAt":...}}
{"type":"tool/result","data":{"turn":1,"step":1,"message":{
   "role":"tool","source":{"kind":"tool","callId":"call_00_..."},"toolCallId":"call_00_...",
   "content":[{"type":"text","text":"TOOL_PROBE_OK\r\n"}],"isError":false,"id":"..."},
  "meta":{"cwd":"D:\\WK_file\\_ref\\sdk-test\\workspace"},
  "sourceEventSeqs":[18],"surfaceOp":"append"}}
```

A `write` tool result text is wrapped as
`<path>D:\...\probe.txt</path>\n<type>file</type>\n<content>\nCreated file\n</content>` and its
`meta` is `{operation:"create",path:"...",diffs:[]}`. The timer/abort details are in
`job/*`; the UI should render from `tool/call` for the "running" state and `tool/result` for
completion.

Multi-turn and sessions:

- Same `sessionId`, sequential prompts: history is preserved (asked "which word did I say",
  answered correctly; 0.9 s), turn numbers increment.
- New `sessionId`: fresh history.
- Persisted session in a new process: `session/prompt` on the old id fails fast with
  `{"code":-32603,"message":"session \"<id>\" already exists"}` and no events. Use
  `session/resume {sessionId}` which returns `{}` in ~28 ms, sends no replayed events, and then
  accept prompts on that id. Verified across full process kill/restart with the same
  `DSH_HOME`: codeword from turn 1 was recalled in turn 2 of the new process.
- `session/resume` on an open session: `SDK session is already open or opening: <id>`
  (`-32603`). On a missing id: `session "<id>" not found` (`-32603`).

## 5. Slash commands: use `session/query`, not `session/prompt`

The installed 0.2.2 server adds `session/query {sessionId, contentBlocks}`. It routes a
recognized command and returns `{kind:"command",execution}`; unrecognized text becomes an
ordinary prompt receipt `{kind:"prompt",messageId}`.

Recognized commands: bare `/compact`, `/permission <preset>`, `/plan ...`, `/goal ...`.
`/model` and `/help` are NOT commands (observed as ordinary prompts). A command requires one
complete text block, optionally accompanied by encoded image blocks
(`{type:"image",data,mimeType}`); other block combinations are rejected. `session/prompt`
never routes commands: prompting `"/permission read-only"` produced a normal model turn and no
preset change.

Verified command exchanges:

```json
// request
{"jsonrpc":"2.0","id":3,"method":"session/query","params":{"sessionId":"...","contentBlocks":[{"type":"text","text":"/permission read-only"}]}}
// notification before the response
{"method":"session.query.completed","params":{"sessionId":"...","commandId":"cmd-6b085638-1","finishReason":"completed","finalResponse":"preset read-only"}}
// response
{"jsonrpc":"2.0","id":3,"result":{"kind":"command","execution":{"commandId":"cmd-6b085638-1","result":{"kind":"success","text":"preset read-only"}}}}
```

```
/permission workspace-write -> success "preset workspace-write"; events permission/preset + sandbox/mode
/plan off                   -> success "Plan mode is already inactive."
/compact                    -> success "Compacted 5 history items (~1154 tokens).", sourceEventSeq:33; took 6.1 s
/help                       -> {kind:"prompt",messageId}; ordinary model turn, no command
```

Command notifications precede the RPC response; preserve order. A command may take a model
turn (`/compact`), so the host should wait for `session.query.completed` for the same
`commandId` before reporting completion. For state-only commands the notification can arrive
before the response.

## 6. Approvals (server->client requests exist at 0.2.2)

This contradicts the 0.0.1 protocol types. When `initialize.approvalRequests:true`, the server
sends JSON-RPC requests (they have an `id`, must be answered):

```json
{"jsonrpc":"2.0","id":11,"method":"approval/request","params":{
  "sessionId":"c503c565-...",
  "toolName":"write",
  "callId":"call_00_XKW294...",
  "reason":"escalate sandbox to danger-full-access: The requested file path D:\\...\\outside-allowed.txt lies outside the session workspace, so writing it requires access beyond workspace-write."}}
```

Response: `{"outcome":"allowed-once"}` or `{"outcome":"rejected"}` or
`{"outcome":"cancelled"}`. Verified: `allowed-once` let the write proceed and the file was
created; `rejected` made the tool result say
`Error: the user rejected escalating this operation to "danger-full-access"; it stays denied, so stop and explain instead of working around it`
and the file stayed absent. Default policy (`permission/preset workspace-write`,
`approval/policy "ask"`) means normal writes inside the workspace need no approval; only
sandbox escalation does. First attempt at an out-of-workspace write is denied with
`[sandbox: file access denied under workspace-write mode]` plus a hint that escalation is
available; the model then retries with `sandbox_permissions` and that retry triggers
`approval/request`.

Extension implication: build an approval prompt UI. If `approvalRequests` is not enabled, the
escalation cannot be granted; expect a denial instead (not separately tested with the flag off,
but the server has no other channel to ask the user). `DSH_PERMISSION_MODE` env can set the
starting policy (`read-only` | `workspace-write` | `danger-full-access`; when
`danger-full-access`, approval policy is `never`).

### User questions

With `initialize.capabilities.userQuestions:true`, the `ask_user_question` tool turns into a
server request:

```json
{"jsonrpc":"2.0","id":12,"method":"user-question/ask","params":{
  "requestId":"3f5b8afc-eb40-4730-8c60-928e9fd335cd",
  "sessionId":"28bc4413-...",
  "questions":[{"id":"color","question":"Pick a color","header":"Color",
                "options":[{"label":"red"},{"label":"blue"}]}]}}
```

Answer `{answers:[{id:"color",selected:["red"]}]}`; the tool result then contains that JSON and
the model continues. Answer `{cancelled:true}` dismisses (maps to `ASK_CANCELLED`). Without
the capability, in-process answerers handle it; otherwise the tool reports `NO_PROVIDER`.
A `user-question.cancelled` notification identifies a request the host no longer waits on.
The extension should bridge this to `vscode.window.showQuickPick`/`showInputBox`.

## 7. Abort and shutdown behavior

- No cancel method exists (`session/wait` is only a completion barrier; `session/resume` and
  `session/query` do not cancel a running turn).
- `shutdown` during a busy turn was answered `{}` in 124 ms and the process exited code 0;
  no assistant message for the turn was committed. So graceful abort = send `shutdown`, close
  stdin, wait ~2-5 s, then kill.
- `SIGTERM` mid-generation: process exited in 62 ms with signal `SIGTERM`; `SIGKILL`: 62 ms
  with `SIGKILL`. No crash dump, no lingering child in subsequent checks. On Windows, killing
  with `child.kill('SIGTERM')` on the Electron-as-node process is effectively a hard
  terminate; do not rely on cleanup handlers firing (no flush guarantee beyond what already
  reached the log).
- stdin EOF without `shutdown`: process exited code 0 in 118 ms. This is the cheapest clean
  stop if no turn is running.
- Calling `shutdown` twice: second call still answers `{}`; after exit, further requests reject
  with `runtime exited code=0 signal=null`. Close the transport after the first shutdown.
- Runtime stdout never carried logs; stderr carried human log lines only. Keep stderr piped and
  capture it for diagnostics, but do not parse it as protocol. If the extension spawns the
  runtime with `stdio: 'ignore'` on stderr, a chatty stderr cannot fill a buffer and deadlock
  (the pipe would be drained anyway if inherited); piping and discarding is fine.

## 8. What the sdk profile inherits from `dsh-base`

Observed in `request/header.tools` (30 tools, full product surface, not a minimal tree):

```
ask_user_question create_goal edit get_goal glob grep interrupt_agent job_kill job_list
job_output list_agents plugin_manager present pwsh read read_image schedule_create
schedule_edit schedule_list schedule_view send_message skill subagent subagent_fork
todo_write update_goal web_fetch web_search workflow working_directory write
```

- `~/.dsh/AGENTS.md` was injected as a `<system-reminder>` user message on every turn.
- A workspace-level `AGENTS.md` was also picked up: created `AGENTS.md` in the spawned cwd
  containing `MAGIC-WORD-7f3a9c`, asked "what is the magic word from the workspace
  instructions", got exactly `MAGIC-WORD-7f3a9c` (6.0 s). One injected `user/message` context
  event carried the marker.
- The user's skill catalog was injected (`<available_skills>` listed
  `diagnose-windows-sandbox-acl`), so `skill` works.
- MCP: the composed tree has the MCP plugins and `mcp-resources`, but this profile has no MCP
  servers configured; no MCP tools appeared in the 30. Reachability of an actual MCP server
  was not tested (none configured on this machine).
- Persona/system prompt: "You are an AI agent powered by DeepSeek Harness." + model persona
  prefix; `request/context.contextWindow` reported 1048576 for `deepseek-flash`.
- Conversation model default: `deepseek-official` / `deepseek-flash` (vendor may adjust).
- Persistence: session JSONL under `%DSH_HOME%\sessions`, storage JSON under
  `%DSH_HOME%\storages`; `session/title` fallback titles are generated.

Not tested (out of time, not needed for the extension decision): subagent notifications
(`subagent.started/finished`), workflow fan-out, `session/wait` success path, concurrent
sessions in one runtime, `/goal` and `/plan` model-turn variants.

## 9. Error shapes and pitfalls

| Situation | Wire result |
| --- | --- |
| unknown provider at `initialize` | `-32603 no adapter registered for provider "<name>"` (~1 s) |
| missing `cwd` | `-32603 The "paths[0]" argument must be of type string. Received undefined` |
| relative `cwd` | accepted, resolved against process cwd (avoid) |
| unknown model | `initialize` succeeds; prompt is accepted; error materializes later at the model request (not captured to completion) |
| prompt on persisted closed session | `-32603 session "<id>" already exists` |
| `session/resume` unknown id | `-32603 session "<id>" not found` |
| `session/resume` open session | `-32603 SDK session is already open or opening: <id>` |
| `session/wait` unknown id | `-32603 unknown SDK session: <uuid>` |
| invalid content block type on prompt | prompt accepted, then `turn/end reason.kind:"error"` `{"message":"DeepSeek Messages cannot represent user/tool-result content bogus","code":"UNSUPPORTED_CONTENT"}` |
| empty `contentBlocks` on prompt | accepted at receipt level (no immediate validation observed) |
| request after shutdown | transport rejects with `runtime exited code=0 signal=null` |

Pitfalls for the implementer:

- Wait on `turn/end`, not `idle` (idle races across turns).
- Prompt receipt is not success; the turn can still end with `reason.kind:"error"`.
- `assistant/message` may exist with empty `text` block during reasoning; render reasoning
  separately (it is in `content[]` with `type:"reasoning"`, and in `reasoning-chunks`).
- `tool-call.arguments` is a JSON string; `tool/result.message.content` is blocks.
- Session events for all sessions arrive on one stream; filter by `sessionId`.
- An HTTP proxy between extension and runtime is unnecessary; the wire is stdio only.
- On Windows, spawn the `.exe` directly with `windowsHide: true`; do not use `shell:true`.
- If the extension reloads, previous runtime must be killed (no orphaned runtime should outlive
  the webview). Track the PID returned by `spawn`.

## 10. Fresh `DSH_HOME` failure (packaging consequence)

Launching `--profile sdk` with an empty `DSH_HOME` does not work out of the box: the runtime
creates `%DSH_HOME%\profiles\sdk` with the bundle package.json and yml files, then startup
fails with exit code 1 and

```
StartupError: dsh: startup failed: 4 required plugins did not activate
  tool-plugin-manager: ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-plugin-manager'
  imported from <fresh-home>\profiles\sdk\
Full diagnostics: <fresh-home>\logs\startup-....log
```

The profile directory needs its `node_modules` installed (in the desktop install this is done
by the desktop bootstrap; the machine's real `%DSH_HOME%\profiles\node_modules` contains the
packages). An extension that ships its own runtime must either reuse the user's existing
`DSH_HOME` (and its installed profile) or run the same install step before first launch.
Simply pointing `DSH_HOME` at a temp dir is not a sandboxing shortcut.

## 11. Reconstructed timeline (for UI expectations)

```
spawn -> initialize        ~1.3-2.9 s (model catalog fetch on first call)
initialize -> prompt receipt ~18 ms
prompt -> first event      ~12 ms
prompt -> turn/end         0.75-1.1 s (one-word), 2.6 s (two tools), 4.3 s (512-token text),
                           6.0-6.1 s (AGENTS.md answer, /compact)
turn/end -> idle           same tick / +1-2 ms
shutdown -> exit           124 ms
SIGTERM/SIGKILL -> exit    62 ms
stdin EOF -> exit          118 ms
```

Process hygiene: every spawned `--profile sdk` runtime exited; post-test process list contained
only the desktop tree (main 7196, host 37128 and helpers) and unrelated `--profile web`
runtimes started by another recon task. No `--profile sdk` process remained.

## 12. Recommendation for the extension

Use stdio. Spawn one runtime per workspace (lazily, on first prompt), keep the child for the
lifecycle of the workspace, and store `sessionId` per conversation:

1. `initialize` with absolute `cwd`, `provider:"deepseek-official"`, `model:"deepseek-flash"`,
   `maxTokens`, `approvalRequests:true`, `capabilities:{userQuestions:true}`.
2. Send prompts through `session/query` so `/compact`, `/permission`, `/plan`, `/goal` work from
   the chat input; send plain text through `session/query` too (it preserves blocks) or
   `session/prompt` if you do not want command routing.
3. Render `assistant/message` when it arrives; replay `stream[]` if you want a typing
   animation. Show a "working" state from `turn/start` to `turn/end`.
4. Implement `approval/request` and `user-question/ask` handlers with VS Code modal/quick-pick
   UI; answer with the exact outcome shapes.
5. For abort: `shutdown` + stdin EOF, fallback SIGTERM after 2 s, SIGKILL after 3 s. Do not
   reuse the process afterwards.
6. Resume a stored conversation with `session/resume {sessionId}` after a new spawn; expect no
   replayed history, so load prior messages from your own store or from the persisted session
   log.

Cost of the SDK path: ~200 MB Electron process per runtime, write a ~200-line transport plus
bridges, handle crashes/orphans, no token streaming. Cost of the HTTP web-API path: dependency
on the desktop app's running server (`127.0.0.1:54276`), shared/global session state, port
conflicts, and whatever auth the web API exposes; benefits are that the server is already warm
and that its HTTP/SSE surface may offer streaming the stdio SDK does not. Choose stdio if the
extension must be self-contained; choose the web API only if it demonstrably provides live
token streaming and you accept coupling to the desktop process.
