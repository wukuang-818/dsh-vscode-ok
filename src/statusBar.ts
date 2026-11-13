import * as vscode from 'vscode';
import type { AgentEvent, ChatState } from './shared/protocol';
import type { ChatController } from './chat/controller';

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly controller: ChatController) {
    this.item = vscode.window.createStatusBarItem('dsh.status', vscode.StatusBarAlignment.Right, 90);
    this.item.name = 'dsh-vscode-ok';
    this.item.command = 'dsh.focusChat';
    this.subscription = controller.onAgentEvent((event) => this.onEvent(event));
    this.update(controller.getState());
    this.item.show();
  }

  dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }

  update(state: ChatState): void {
    const backend = state.backend;
    if (backend.status === 'ready') {
      this.item.text = state.session.running ? '$(loading~spin) dsh-vscode-ok' : '$(sparkle) dsh-vscode-ok';
      this.item.backgroundColor = undefined;
      this.item.color = undefined;
    } else if (backend.status === 'starting') {
      this.item.text = '$(loading~spin) dsh-vscode-ok';
      this.item.backgroundColor = undefined;
    } else if (backend.status === 'error') {
      this.item.text = '$(warning) dsh-vscode-ok';
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.item.color = undefined;
    } else {
      this.item.text = '$(debug-disconnect) dsh-vscode-ok';
      this.item.backgroundColor = undefined;
    }
    const lines = [
      `Backend: ${backend.status}${backend.detail ? ` (${backend.detail})` : ''}`,
      `Session: ${state.session.title || state.session.id || 'none'}`,
      `Model: ${state.session.model?.label ?? 'default'}`,
      `Permission: ${state.session.permission}`,
    ];
    this.item.tooltip = lines.join('\n');
  }

  private onEvent(event: AgentEvent): void {
    if (
      event.type === 'backend-ready' ||
      event.type === 'backend-exit' ||
      event.type === 'session' ||
      event.type === 'models'
    ) {
      this.update(this.controller.getState());
    }
  }
}
