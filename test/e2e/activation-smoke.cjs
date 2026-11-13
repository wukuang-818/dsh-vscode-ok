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
  const port = await freePort();
  configOverrides.set('dsh.port', port);
  configOverrides.set('dsh.reuseExisting', false);
  configOverrides.set('dsh.autoStart', true);
  configOverrides.set('dsh.debug', true);
  log(`using port ${port}`);

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

  await waitFor(
    () => posted.some((m) => m.type === 'backend' && m.status === 'ready'),
    180000,
    'backend ready',
  );
  log('backend reported ready');

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

  const leftovers = require('node:child_process')
    .execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'DeepSeek Harness.exe' -and $_.CommandLine -match '--profile web --port ${port}' } | Select-Object -ExpandProperty ProcessId`,
    ])
    .toString()
    .trim();
  log(`leftover backend processes: ${leftovers || '(none)'}`);

  fs.writeFileSync(path.join(os.tmpdir(), 'dsh-vscode-e2e-activation.log'), lines.join('\n'));
  log('RESULT: PASS');
  process.exit(0);
})().catch((error) => {
  log(`RESULT: FAIL ${error && error.stack ? error.stack : error}`);
  try {
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
