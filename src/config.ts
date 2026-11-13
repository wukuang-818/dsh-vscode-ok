import * as vscode from 'vscode';
import type { PermissionPreset } from './shared/protocol';

export interface ExtensionConfig {
  executable: string;
  executableArgs: string[];
  host: string;
  port: number;
  reuseExisting: boolean;
  autoStart: boolean;
  dshHome: string;
  profile: string;
  model: string;
  permissionPreset: PermissionPreset;
  agentPreset: string;
  effort: string;
  startTimeoutMs: number;
  commandTimeoutMs: number;
  confirmBeforeSend: boolean;
  includeEditorContext: boolean;
  includeDiagnostics: boolean;
  debug: boolean;
}

const SECTION = 'dsh';

export function readConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const port = cfg.get<number>('port', 3080);
  return {
    executable: (cfg.get<string>('executable', '') ?? '').trim(),
    executableArgs: cfg.get<string[]>('executableArgs', []) ?? [],
    host: (cfg.get<string>('host', '127.0.0.1') ?? '127.0.0.1').trim(),
    port: Number.isFinite(port) && port > 0 && port < 65536 ? port : 3080,
    reuseExisting: cfg.get<boolean>('reuseExisting', true),
    autoStart: cfg.get<boolean>('autoStart', true),
    dshHome: (cfg.get<string>('dshHome', '') ?? '').trim(),
    profile: (cfg.get<string>('profile', '') ?? '').trim(),
    model: (cfg.get<string>('model', '') ?? '').trim(),
    permissionPreset: cfg.get<PermissionPreset>('permissionPreset', 'workspace-write'),
    agentPreset: (cfg.get<string>('agentPreset', '') ?? '').trim(),
    effort: (cfg.get<string>('effort', '') ?? '').trim(),
    startTimeoutMs: cfg.get<number>('startTimeoutMs', 120000),
    commandTimeoutMs: cfg.get<number>('commandTimeoutMs', 600000),
    confirmBeforeSend: cfg.get<boolean>('confirmBeforeSend', true),
    includeEditorContext: cfg.get<boolean>('includeEditorContext', true),
    includeDiagnostics: cfg.get<boolean>('includeDiagnostics', true),
    debug: cfg.get<boolean>('debug', false),
  };
}

export function dshHomeDir(config: ExtensionConfig): string {
  if (config.dshHome) {
    return config.dshHome;
  }
  const home = process.env['USERPROFILE'] || process.env['HOME'] || '';
  return home ? `${home}${process.platform === 'win32' ? '\\' : '/'}.dsh` : '';
}

/** Workspace root the agent should run in. */
export function workspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0 && folders[0]) {
    return folders[0].uri.fsPath;
  }
  return undefined;
}

export function workspaceInfo(): { name: string; cwd: string; isSingleFolder: boolean } {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const first = folders[0];
  if (!first) {
    return { name: 'No folder open', cwd: process.cwd(), isSingleFolder: false };
  }
  return { name: first.name, cwd: first.uri.fsPath, isSingleFolder: folders.length === 1 };
}
