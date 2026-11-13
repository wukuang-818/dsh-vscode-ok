import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function initLog(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('DSH');
  }
  return channel;
}

export function log(...parts: unknown[]): void {
  const text = parts
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      try {
        return JSON.stringify(part);
      } catch {
        return String(part);
      }
    })
    .join(' ');
  initLog().appendLine(`[${new Date().toISOString()}] ${text}`);
}

export function showLogs(): void {
  initLog().show(true);
}

export function disposeLog(): void {
  channel?.dispose();
  channel = undefined;
}
