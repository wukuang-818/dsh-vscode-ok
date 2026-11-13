/**
 * Activation smoke test for the DSH VS Code extension.
 *
 * Loads the built `dist/extension.js` with a stubbed `vscode` module, runs
 * `activate()`, attaches a fake webview view, sends a real prompt through the
 * real `dsh web` backend, and asserts the streamed answer arrives. This is the
 * closest automated equivalent to opening the DSH sidebar in VS Code.
 */
'use strict';

const Module = require('module');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const repo = path.resolve(__dirname, '..', '..');
const workspace = process.env.DSH_E2E_WORKSPACE || path.join(os.tmpdir(), 'dsh-vscode-e2e-workspace');
for (const file of ['hello.py', 'README.md']) {
  const target = path.join(workspace, file);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(target, file.endsWith('.py') ? "def greet(name):\n    return f'hi {name}'\n" : '# e2e workspace\n');
  }
}
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));

// --- diagnostics log -------------------------------------------------------
const lines = [];
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  lines.push(line);
  process.stdout.write(line + '\n');
}

// --- minimal vscode API ----------------------------------------------------
class Disposable {
  constructor(fn) {
    this._fn = fn;
  }
  dispose() {
    if (this._fn) {
      const fn = this._fn;
      this._fn = undefined;
      fn();
    }
  }
  static from(...items) {
    return new Disposable(() => items.forEach((i) => i && i.dispose && i.dispose()));
  }
}

class EventEmitter {
  constructor() {
    this._listeners = new Set();
    this.event = (listener) => {
      this._listeners.add(listener);
      return new Disposable(() => this._listeners.delete(listener));
    };
  }
  fire(value) {
    for (const listener of [...this._listeners]) listener(value);
  }
  dispose() {
    this._listeners.clear();
  }
}

function makeUri(fsPath) {
  const normalized = path.resolve(fsPath);
  return {
    scheme: 'file',
    authority: '',
    path: '/' + normalized.replace(/\\/g, '/').replace(/^\/+/, ''),
    fsPath: normalized,
    toString() {
      return 'file:///' + normalized.replace(/\\/g, '/');
    },
    with(change) {
      return makeUri(change.path || normalized);
    },
  };
}

const configOverrides = new Map();
const contributions = pkg.contributes && pkg.contributes.configuration;
const defaults = new Map();
for (const block of Array.isArray(contributions) ? contributions : [contributions]) {
  if (!block || !block.properties) continue;
  for (const [key, schema] of Object.entries(block.properties)) {
    if (schema && Object.prototype.hasOwnProperty.call(schema, 'default')) {
      defaults.set(key, schema.default);
    }
  }
}

const outputLines = [];
function getConfiguration(section) {
  const prefix = section ? `${section}.` : '';
  return {
    has(key) {
      return defaults.has(prefix + key) || configOverrides.has(prefix + key);
    },
    get(key, fallback) {
      const full = prefix + key;
      if (configOverrides.has(full)) return configOverrides.get(full);
      if (defaults.has(full)) return defaults.get(full);
      return fallback;
    },
    inspect(key) {
      const full = prefix + key;
      return defaults.has(full) || configOverrides.has(full)
        ? { key: full, defaultValue: configOverrides.get(full) ?? defaults.get(full) }
        : undefined;
    },
    async update(key, value) {
      configOverrides.set(prefix + key, value);
    },
  };
}

const commandHandlers = new Map();
const participants = [];
let webviewProvider;
let statusBarItems = [];
const posted = [];
const windowMessages = [];
const capabilities = [];

function recordCapability(name, status, detail) {
  capabilities.push({ name, status, detail: detail || '' });
  log(`capability ${name}: ${status}${detail ? ` — ${detail}` : ''}`);
}

function printCapabilityTable() {
  if (capabilities.length === 0) return;
  const nameWidth = Math.max(...capabilities.map((row) => row.name.length), 4);
  log('capability summary:');
  for (const row of capabilities) {
    log(`  ${row.status.padEnd(4)}  ${row.name.padEnd(nameWidth)}  ${row.detail}`);
  }
}

const workspaceConfigEmitter = new EventEmitter();
const workspaceFoldersEmitter = new EventEmitter();
const closeDocumentEmitter = new EventEmitter();
const activeEditorEmitter = new EventEmitter();

const vscodeStub = {
  version: '1.146.0',
  Disposable,
  EventEmitter,
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Active: -1, One: 1, Two: 2, Beside: -2 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ExtensionMode: { Production: 1, Development: 2, Test: 3 },
  ProgressLocation: { Notification: 15, Window: 10, SourceControl: 1 },
  ThemeIcon: class ThemeIcon {
    constructor(id) {
      this.id = id;
    }
  },
  Uri: {
    file: makeUri,
    parse(value) {
      const stripped = String(value).replace(/^file:\/\//, '');
      return makeUri(decodeURIComponent(stripped));
    },
    joinPath(base, ...parts) {
      return makeUri(path.join(base.fsPath, ...parts.map(String)));
    },
  },
  env: {
    clipboard: {
      async writeText(text) {
        log(`clipboard.writeText(${JSON.stringify(text)})`);
      },
      async readText() {
        return '';
      },
    },
    openExternal: async () => true,
  },
  commands: {
    registerCommand(id, handler) {
      commandHandlers.set(id, handler);
      return new Disposable(() => commandHandlers.delete(id));
    },
    async executeCommand(id, ...args) {
      const handler = commandHandlers.get(id);
      if (!handler) return undefined;
      return handler(...args);
    },
    getCommands: async () => [...commandHandlers.keys()],
  },
  languages: {
    getDiagnostics() {
      return [];
    },
  },
  chat: {
    createChatParticipant(id, handler) {
      const participant = { id, handler, dispose() {} };
      participants.push(participant);
      return participant;
    },
  },
  workspace: {
    workspaceFolders: [{ uri: makeUri(workspace), name: path.basename(workspace), index: 0 }],
    textDocuments: [],
    fs: {
      async readFile(uri) {
        return fs.readFileSync(uri.fsPath);
      },
      async stat(uri) {
        const s = fs.statSync(uri.fsPath);
        return { type: s.isDirectory() ? 2 : 1, ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size };
      },
      async writeFile(uri, content) {
        fs.writeFileSync(uri.fsPath, Buffer.from(content));
      },
      async createDirectory(uri) {
        fs.mkdirSync(uri.fsPath, { recursive: true });
      },
    },
    getConfiguration,
    asRelativePath(value) {
      const target = typeof value === 'string' ? value : value.fsPath;
      return path.relative(workspace, target).replace(/\\/g, '/');
    },
    // Minimal file search: the extension indexes the workspace for @-mentions.
    async findFiles(_include, exclude, maxResults) {
      const limit = typeof maxResults === 'number' && maxResults > 0 ? maxResults : 2000;
      const skipped = new Set(['node_modules', '.git', 'dist', 'out', '.next', '.cache']);
      const found = [];
      const walk = (dir) => {
        if (found.length >= limit) return;
        let entries = [];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (found.length >= limit) return;
          const target = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!skipped.has(entry.name)) walk(target);
          } else if (entry.isFile()) {
            found.push(makeUri(target));
          }
        }
      };
      walk(workspace);
      void exclude;
      return found;
    },
    onDidChangeConfiguration: workspaceConfigEmitter.event,
    onDidChangeWorkspaceFolders: workspaceFoldersEmitter.event,
    onDidCloseTextDocument: closeDocumentEmitter.event,
    getWorkspaceFolder(uri) {
      return { uri: makeUri(workspace), name: path.basename(workspace), index: 0 };
    },
    async openTextDocument(arg) {
      const file = typeof arg === 'string' ? arg : arg.fsPath || arg.toString();
      return {
        uri: makeUri(file),
        fileName: file,
        languageId: 'plaintext',
        getText: () => fs.readFileSync(file, 'utf8'),
        positionAt() {
          return { line: 0, character: 0 };
        },
        lineCount: 1,
      };
    },
  },
  window: {
    activeTextEditor: undefined,
    activeTerminal: undefined,
    createOutputChannel(name) {
      return {
        name,
        append(value) {
          outputLines.push(value);
        },
        appendLine(value) {
          outputLines.push(String(value) + '\n');
        },
        show() {},
        hide() {},
        dispose() {},
      };
    },
    createStatusBarItem() {
      const item = {
        text: '',
        tooltip: '',
        command: undefined,
        show() {},
        hide() {},
        dispose() {},
      };
      statusBarItems.push(item);
      return item;
    },
    registerWebviewViewProvider(viewType, provider) {
      webviewProvider = { viewType, provider };
      return new Disposable(() => {
        webviewProvider = undefined;
      });
    },
    onDidChangeActiveTextEditor: activeEditorEmitter.event,
    async showQuickPick() {
      return undefined;
    },
    async showInputBox() {
      return undefined;
    },
    async showOpenDialog() {
      return undefined;
    },
    async showErrorMessage(message) {
      windowMessages.push({ level: 'error', message });
      log(`showErrorMessage: ${message}`);
      return undefined;
    },
    async showWarningMessage(message) {
      windowMessages.push({ level: 'warning', message });
      log(`showWarningMessage: ${message}`);
      return undefined;
    },
    async showInformationMessage(message) {
      windowMessages.push({ level: 'info', message });
      log(`showInformationMessage: ${message}`);
      return undefined;
    },
    setStatusBarMessage() {
      return new Disposable(() => {});
    },
    async showTextDocument(document) {
      return { document, options: undefined };
    },
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};

// --- fake webview ----------------------------------------------------------
const webviewReceiver = new EventEmitter();
const webviewMessageEmitter = new EventEmitter();
const fakeWebview = {
  options: undefined,
  html: undefined,
  cspSource: 'vscode-resource:',
  asWebviewUri: (uri) => ({ toString: () => `vscode-resource:${uri.fsPath}` }),
  async postMessage(message) {
    posted.push(message);
    webviewMessageEmitter.fire(message);
    return true;
  },
  onDidReceiveMessage: webviewReceiver.event,
};
const fakeView = {
  webview: fakeWebview,
  visible: true,
  onDidChangeVisibility: new EventEmitter().event,
  onDidDispose: new EventEmitter().event,
};

async function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}

function freePort() {
  const net = require('node:net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

(async () => {
  const net = require('node:net');
  const port = await freePort();
  // Occupy the configured port so the extension has to fall back to a free one.
  const blocker = net.createServer();
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(port, '127.0.0.1', resolve);
  });
  configOverrides.set('dsh.port', port);
  configOverrides.set('dsh.reuseExisting', true);
  configOverrides.set('dsh.autoStart', true);
  configOverrides.set('dsh.debug', true);
  log(`configured port ${port} is occupied on purpose`);

  const extension = require(path.join(repo, 'dist', 'extension.js'));
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-'));
  const context = {
    subscriptions: [],
    extensionUri: makeUri(repo),
    extensionPath: repo,
    extension: {
      id: `${pkg.publisher}.${pkg.name}`,
      extensionUri: makeUri(repo),
      extensionPath: repo,
      packageJSON: pkg,
      isActive: true,
      exports: undefined,
    },
    storageUri: makeUri(storageDir),
    globalStorageUri: makeUri(storageDir),
    logUri: makeUri(storageDir),
    extensionMode: 3,
    globalState: {
      _values: new Map(),
      get(key, fallback) {
        return this._values.has(key) ? this._values.get(key) : fallback;
      },
      async update(key, value) {
        this._values.set(key, value);
      },
      keys() {
        return [...this._values.keys()];
      },
    },
    workspaceState: {
      get(_key, fallback) {
        return fallback;
      },
      async update() {},
      keys() {
        return [];
      },
    },
    secrets: {
      async get() {
        return undefined;
      },
      async store() {},
      async delete() {},
      onDidChange: new EventEmitter().event,
    },
    environmentVariableCollection: { replace() {}, clear() {}, get() {} },
    asAbsolutePath(p) {
      return path.join(repo, p);
    },
  };

  log('activating extension');
  extension.activate(context);
  log(`activated: subscriptions=${context.subscriptions.length}, commands=${commandHandlers.size}, participant=${participants.length}`);
  if (!webviewProvider) throw new Error('webview view provider was not registered');
  if (commandHandlers.size < 10) throw new Error(`expected many commands, got ${commandHandlers.size}`);
  if (participants.length !== 1) throw new Error('chat participant was not registered');

  // Resolve the view like VS Code does when the sidebar becomes visible.
  webviewProvider.provider.resolveWebviewView(fakeView, { state: {} }, {});
  log(`view resolved, html=${fakeWebview.html ? fakeWebview.html.length : 0} bytes`);

  await waitFor(() => posted.some((m) => m.type === 'init') === false, 50, 'pre-ready silence').catch(() => {});
  // Simulate the webview booting: it sends "ready" and expects the init state back.
  webviewReceiver.fire({ type: 'ready' });
  await waitFor(() => posted.some((m) => m.type === 'init'), 30000, 'init message');
  const init = posted.find((m) => m.type === 'init');
  log(`init: workspace=${init.state && init.state.workspace && init.state.workspace.name}, backend=${JSON.stringify(init.state && init.state.backend)}`);

  const readyMessage = await waitFor(
    () => posted.find((m) => m.type === 'backend' && m.status === 'ready'),
    180000,
    'backend ready',
  );
  const readyUrl = String(readyMessage.detail || '');
  const readyPort = Number((/\:(\d+)/.exec(readyUrl) || [])[1] || 0);
  log(`backend reported ready at ${readyUrl}`);
  if (!readyPort) throw new Error('backend ready message did not include a URL');
  if (readyPort === port) throw new Error('extension did not fall back to a free port');
  if (!outputLines.join('').includes(`starting the runtime on ${readyPort}`)) {
    log('WARNING: no port-fallback log line in the output channel');
  }

  webviewReceiver.fire({ type: 'send', text: 'Reply with exactly the word pong and nothing else.', attachments: [] });

  const done = await waitFor(
    () => posted.find((m) => m.type === 'message-status' && m.status === 'done'),
    180000,
    'assistant message done',
  );
  const messageId = done.messageId;
  const text = posted
    .filter((m) => m.type === 'delta' && m.messageId === messageId)
    .map((m) => m.text)
    .join('');
  log(`assistant text (${text.length} chars): ${JSON.stringify(text.slice(0, 400))}`);
  if (!/pong/i.test(text)) throw new Error('streamed answer did not contain the expected content');

  const toolCards = posted.filter((m) => m.type === 'tool');
  log(`tool events: ${toolCards.length}`);

  /* --------------------------------------------------------------------- */
  /* Capability contract                                                   */
  /* --------------------------------------------------------------------- */

  // request-files: filtered, workspace-relative posix paths.
  const filesFrom = posted.length;
  webviewReceiver.fire({ type: 'request-files', query: 'readme' });
  const filesMessage = await waitFor(
    () =>
      posted
        .slice(filesFrom)
        .find(
          (m) =>
            m.type === 'files' &&
            Array.isArray(m.files) &&
            m.files.length > 0 &&
            m.files.every((file) => typeof file === 'string' && /readme/i.test(file)),
        ),
    60000,
    'files message for query "readme"',
  );
  for (const file of filesMessage.files) {
    if (typeof file !== 'string') throw new Error('files message contained a non-string entry');
    if (/^[a-zA-Z]:[\\/]/.test(file) || file.startsWith('/') || file.includes('\\')) {
      throw new Error(`files message must contain workspace-relative posix paths, got ${JSON.stringify(file)}`);
    }
  }
  if (!filesMessage.files.some((file) => /^readme\.md$/i.test(file))) {
    throw new Error(`files message did not include README.md: ${JSON.stringify(filesMessage.files.slice(0, 5))}`);
  }
  recordCapability('request-files', 'PASS', `${filesMessage.files.length} match(es), e.g. ${filesMessage.files[0]}`);

  // search-sessions: always answers with an array, even when nothing matches.
  const searchFrom = posted.length;
  webviewReceiver.fire({ type: 'search-sessions', query: 'pong' });
  const searchMessage = await waitFor(
    () => posted.slice(searchFrom).find((m) => m.type === 'search-results'),
    60000,
    'search-results message',
  );
  if (!Array.isArray(searchMessage.items)) {
    throw new Error('search-results did not carry an items array');
  }
  for (const hit of searchMessage.items) {
    if (typeof hit.sessionId !== 'string' || typeof hit.snippet !== 'string') {
      throw new Error(`malformed session hit: ${JSON.stringify(hit)}`);
    }
  }
  recordCapability('search-sessions', 'PASS', `${searchMessage.items.length} hit(s)`);

  // rename-session: the renamed title must come back over session/sessions.
  const sessionId = [...posted].reverse().find((m) => m.type === 'session' && m.session && m.session.id)?.session.id;
  if (!sessionId) throw new Error('no active session id was reported before rename-session');
  const renameFrom = posted.length;
  webviewReceiver.fire({ type: 'rename-session', sessionId, title: 'e2e renamed' });
  const renamed = await waitFor(
    () =>
      posted.slice(renameFrom).find(
        (m) =>
          (m.type === 'session' && m.session && m.session.id === sessionId && m.session.title === 'e2e renamed') ||
          (m.type === 'sessions' &&
            Array.isArray(m.sessions) &&
            m.sessions.some((session) => session.id === sessionId && session.title === 'e2e renamed')),
      ),
    60000,
    'renamed session title',
  );
  recordCapability('rename-session', 'PASS', `title propagated via ${renamed.type}`);

  // pick-effort: only meaningful when the model advertises efforts.
  const latestSession = [...posted].reverse().find((m) => m.type === 'session' && m.session);
  const efforts = (latestSession && latestSession.session && latestSession.session.model
    ? latestSession.session.model.reasoningEfforts
    : undefined) || [];
  if (efforts.length === 0) {
    recordCapability('pick-effort', 'SKIP', 'model advertises no reasoning efforts');
  } else {
    const effortFrom = posted.length;
    webviewReceiver.fire({ type: 'pick-effort' });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const failure = posted.slice(effortFrom).find((m) => m.type === 'toast' && m.level === 'error');
    if (failure) throw new Error(`pick-effort surfaced an error: ${failure.text}`);
    recordCapability('pick-effort', 'PASS', `${efforts.length} effort(s) offered, quick pick dismissed`);
  }

  // Diagnostics only: the background catalogs are not part of the hard contract.
  await waitFor(
    () => posted.some((m) => m.type === 'commands') && posted.some((m) => m.type === 'skills'),
    30000,
    'background command and skill catalogs',
  ).catch(() => {});
  const commandsMessage = [...posted].reverse().find((m) => m.type === 'commands');
  const skillsMessage = [...posted].reverse().find((m) => m.type === 'skills');
  recordCapability(
    'commands/list',
    commandsMessage ? 'PASS' : 'SKIP',
    commandsMessage ? `${commandsMessage.commands.length} command(s)` : 'no commands message',
  );
  recordCapability(
    'skills/list',
    skillsMessage ? 'PASS' : 'SKIP',
    skillsMessage ? `${skillsMessage.skills.length} skill(s)` : 'no skills message',
  );

  printCapabilityTable();

  // Surface backend-side failures that the capability contract tolerated.
  const noteworthy = outputLines
    .join('')
    .split('\n')
    .filter((line) => /failed|unavailable|gateway\/|session\/search|commands\/list|skills\/list/.test(line));
  if (noteworthy.length > 0) {
    log(`runtime log notes:\n${noteworthy.slice(-12).join('\n')}`);
  }

  log('disposing extension context');
  for (const disposable of context.subscriptions.reverse()) {
    try {
      disposable.dispose();
    } catch (error) {
      log(`dispose error: ${error && error.message}`);
    }
  }

  // Give the backend a moment to reap its child process tree.
  await new Promise((resolve) => setTimeout(resolve, 6000));
  await new Promise((resolve) => blocker.close(resolve));

  const leftovers = require('node:child_process')
    .execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'DeepSeek Harness.exe' -and $_.CommandLine -match '--profile web --port ${readyPort}' } | Select-Object -ExpandProperty ProcessId`,
    ])
    .toString()
    .trim();
  log(`leftover backend processes: ${leftovers || '(none)'}`);
  if (leftovers) throw new Error('the spawned runtime was not stopped with the extension');

  fs.writeFileSync(path.join(os.tmpdir(), 'dsh-vscode-e2e-activation.log'), lines.join('\n'));
  log('RESULT: PASS');
  process.exit(0);
})().catch((error) => {
  log(`RESULT: FAIL ${error && error.stack ? error.stack : error}`);
  try {
    printCapabilityTable();
    log(`posted messages: ${posted.map((m) => m.type).join(', ')}`);
    for (const message of posted.filter((m) => m.type === 'notice' || m.type === 'backend' || m.type === 'toast')) {
      log(`  ${JSON.stringify(message).slice(0, 500)}`);
    }
    log(`output channel tail: ${JSON.stringify(outputLines.join('').slice(-4000))}`);
    log(`window messages: ${JSON.stringify(windowMessages)}`);
  } catch (dumpError) {
    log(`dump failed: ${dumpError && dumpError.message}`);
  }
  try {
    fs.writeFileSync(path.join(os.tmpdir(), 'dsh-vscode-e2e-activation.log'), lines.join('\n'));
  } catch {}
  process.exit(1);
});
