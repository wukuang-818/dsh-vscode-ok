import * as vscode from 'vscode';
import type { ChatController } from './chat/controller';
import { buildPromptText, diagnosticsAttachment, fileAttachment, selectionAttachment } from './context';
import type { ToolDiffStore } from './diffStore';
import { openFileAt } from './diffStore';
import { log } from './log';
import { errorMessage } from './util';

interface CommandDeps {
  controller: ChatController;
  diffStore: ToolDiffStore;
  /** Sends attachments into the composer of the chat view. */
  addAttachments: (attachments: import('./shared/protocol').Attachment[], text?: string) => void;
  showLogs: () => void;
  extensionUri: vscode.Uri;
}

async function prepareAndSend(
  controller: ChatController,
  attachments: import('./shared/protocol').Attachment[],
  fallbackPrompt: string,
): Promise<void> {
  const config = controller.getConfig();
  if (config.confirmBeforeSend) {
    controller.addComposerAttachments(attachments, '');
    return;
  }
  const root = controller.getState().workspace.cwd;
  const text = buildPromptText(fallbackPrompt, attachments, root);
  try {
    await controller.sendPrompt(text, []);
    await controller.focus();
  } catch (error) {
    void vscode.window.showErrorMessage(`DSH: ${errorMessage(error)}`);
  }
}

export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
  const { controller, diffStore } = deps;
  const disposables: vscode.Disposable[] = [];
  const register = (id: string, handler: (...args: unknown[]) => unknown): void => {
    disposables.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await handler(...args);
        } catch (error) {
          log(`command ${id} failed:`, errorMessage(error));
          void vscode.window.showErrorMessage(`DSH: ${errorMessage(error)}`);
        }
      }),
    );
  };

  register('dsh.newChat', async () => {
    await controller.newSession();
    await controller.focus();
  });

  register('dsh.focusChat', async () => {
    await controller.focus();
  });

  register('dsh.startBackend', async () => {
    await controller.ensureStarted();
  });

  register('dsh.restartBackend', async () => {
    await controller.restart();
  });

  register('dsh.stopBackend', async () => {
    await controller.stop();
  });

  register('dsh.showLogs', async () => {
    deps.showLogs();
  });

  register('dsh.openSettings', async () => {
    await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:wukuang-818.dsh-vscode');
  });

  register('dsh.pickModel', async () => {
    await controller.pickModel();
  });

  register('dsh.pickPermission', async () => {
    await controller.pickPermission();
  });

  register('dsh.pickAgent', async () => {
    await controller.pickAgentPreset();
  });

  register('dsh.sendSelection', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showWarningMessage('DSH: open a file and select some code first.');
      return;
    }
    const root = controller.getState().workspace.cwd;
    const attachment = selectionAttachment(editor, root);
    if (!attachment) {
      void vscode.window.showWarningMessage('DSH: no selection in the active editor.');
      return;
    }
    await prepareAndSend(controller, [attachment], 'Explain this selection.');
  });

  register('dsh.sendFile', async (uri?: unknown) => {
    const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
    if (!target) {
      void vscode.window.showWarningMessage('DSH: no file selected.');
      return;
    }
    const root = controller.getState().workspace.cwd;
    const attachment = fileAttachment(target, root);
    if (!attachment) {
      void vscode.window.showWarningMessage('DSH: only local files can be sent.');
      return;
    }
    await prepareAndSend(controller, [attachment], 'Review this file.');
  });

  register('dsh.addFileToChat', async (uri?: unknown) => {
    const target = uri instanceof vscode.Uri ? uri : undefined;
    const root = controller.getState().workspace.cwd;
    let attachments: import('./shared/protocol').Attachment[] = [];
    if (target) {
      const attachment = fileAttachment(target, root);
      if (attachment) {
        attachments = [attachment];
      }
    } else {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: 'Attach to DSH',
        defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
      });
      attachments = (picked ?? [])
        .map((choice) => fileAttachment(choice, root))
        .filter((value): value is import('./shared/protocol').Attachment => Boolean(value));
    }
    if (attachments.length === 0) {
      return;
    }
    deps.addAttachments(attachments);
  });

  register('dsh.attachProblems', async () => {
    const root = controller.getState().workspace.cwd;
    const attachment = diagnosticsAttachment(root);
    if (!attachment) {
      void vscode.window.showInformationMessage('DSH: no diagnostics in the active file.');
      return;
    }
    await prepareAndSend(controller, [attachment], 'Fix these problems.');
  });

  register('dsh.copySessionId', async () => {
    const id = controller.getState().session.id;
    if (!id) {
      void vscode.window.showInformationMessage('DSH: no active session yet.');
      return;
    }
    await vscode.env.clipboard.writeText(id);
    void vscode.window.setStatusBarMessage('DSH session id copied', 2000);
  });

  register('dsh.openFileAt', async (path?: unknown, line?: unknown, endLine?: unknown) => {
    if (typeof path !== 'string') {
      return;
    }
    await openFileAt(path, typeof line === 'number' ? line : undefined, typeof endLine === 'number' ? endLine : undefined);
  });

  register('dsh.openToolDiff', async (toolId?: unknown) => {
    if (typeof toolId !== 'string') {
      return;
    }
    await diffStore.openDiff(toolId);
  });

  return disposables;
}
