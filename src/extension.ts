import * as vscode from 'vscode';
import { workspaceInfo } from './config';
import { ChatController } from './chat/controller';
import { registerChatParticipant } from './chat/participant';
import { ChatViewProvider } from './chat/webviewProvider';
import { registerCommands } from './commands';
import { createWebBackend } from './dsh/webBackend';
import { ToolDiffStore } from './diffStore';
import { disposeLog, initLog, log, showLogs } from './log';
import { StatusBar } from './statusBar';
import { errorMessage } from './util';

/** VS Code 1.106 introduced the secondary sidebar contribution point. */
const MIN_SECONDARY_SIDEBAR_VERSION = [1, 106] as const;
const SUPPORTS_SECONDARY_SIDEBAR_KEY = 'dsh.supportsSecondarySidebar';

let controller: ChatController | undefined;

export function activate(context: vscode.ExtensionContext): void {
  initLog();
  const version = (context.extension.packageJSON as { version?: string }).version ?? '0.0.0';
  log(`activating dsh-vscode-ok ${version} on VS Code ${vscode.version}`);

  void vscode.commands.executeCommand(
    'setContext',
    SUPPORTS_SECONDARY_SIDEBAR_KEY,
    isAtLeast(vscode.version, MIN_SECONDARY_SIDEBAR_VERSION[0], MIN_SECONDARY_SIDEBAR_VERSION[1]),
  );

  const chat = new ChatController((emit) => {
    // Re-read configuration for every launch so setting changes take effect
    // on the next restart without a reload.
    const config = readConfigLite();
    return createWebBackend({
      ...config,
      workspaceRoot: workspaceInfo().cwd,
      emit,
    });
  });
  controller = chat;

  const diffStore = new ToolDiffStore(() => context.storageUri?.fsPath);
  const provider = new ChatViewProvider(context.extensionUri, chat);

  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    registerChatParticipant(chat),
    ...registerCommands({
      controller: chat,
      diffStore,
      addAttachments: (attachments, text) => chat.addComposerAttachments(attachments, text ?? ''),
      showLogs,
      extensionUri: context.extensionUri,
    }),
    diffStore,
    new StatusBar(chat),
    new vscode.Disposable(() => {
      log('deactivating dsh-vscode-ok extension');
      void chat.stop();
      chat.dispose();
      disposeLog();
    }),
  );

  if (readBooleanSetting('autoStart', true)) {
    void chat.ensureStarted().catch((error: unknown) => {
      log('auto start failed:', errorMessage(error));
      void vscode.window.showErrorMessage(`dsh-vscode-ok: ${errorMessage(error)}`);
    });
  }
}

export function deactivate(): void {
  void controller?.stop();
  controller = undefined;
}

/* ------------------------------------------------------------------ */
/* Settings                                                           */
/* ------------------------------------------------------------------ */

/** Subset of the `dsh.*` settings the transport needs at launch time. */
function readConfigLite(): {
  host: string;
  port: number;
  reuseExisting: boolean;
  startTimeoutMs: number;
  debug: boolean;
  executable: string;
  executableArgs: string[];
  dshHome: string;
  profile: string;
  commandTimeoutMs: number;
} {
  const config = vscode.workspace.getConfiguration('dsh');
  const port = config.get<number>('port', 3080);
  return {
    host: (config.get<string>('host', '127.0.0.1') || '127.0.0.1').trim(),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 3080,
    reuseExisting: config.get<boolean>('reuseExisting', true),
    startTimeoutMs: config.get<number>('startTimeoutMs', 120000),
    debug: config.get<boolean>('debug', false),
    executable: (config.get<string>('executable', '') || '').trim(),
    executableArgs: config.get<string[]>('executableArgs', []) ?? [],
    dshHome: (config.get<string>('dshHome', '') || '').trim(),
    profile: (config.get<string>('profile', '') || '').trim(),
    commandTimeoutMs: config.get<number>('commandTimeoutMs', 600000),
  };
}

function readBooleanSetting(key: string, fallback: boolean): boolean {
  return vscode.workspace.getConfiguration('dsh').get<boolean>(key, fallback);
}

function isAtLeast(version: string, major: number, minor: number): boolean {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10));
  const actualMajor = parts[0] ?? 0;
  const actualMinor = parts[1] ?? 0;
  if (actualMajor !== major) {
    return actualMajor > major;
  }
  return actualMinor >= minor;
}
