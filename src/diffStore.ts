import * as vscode from 'vscode';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolCall } from './shared/protocol';

/**
 * Keeps the last known diff for every tool call that touched files so the diff
 * can be opened after the fact.
 */
export class ToolDiffStore implements vscode.Disposable {
  private readonly diffs = new Map<string, ToolCall>();
  private readonly disposable: vscode.Disposable;

  constructor(private readonly storageRoot: () => string | undefined) {
    this.disposable = vscode.workspace.onDidCloseTextDocument(() => undefined);
  }

  dispose(): void {
    this.disposable.dispose();
    this.diffs.clear();
  }

  record(tool: ToolCall): void {
    if (tool.diff) {
      this.diffs.set(tool.id, tool);
      if (this.diffs.size > 200) {
        const oldest = this.diffs.keys().next();
        if (!oldest.done && oldest.value) {
          this.diffs.delete(oldest.value);
        }
      }
    }
  }

  get(toolId: string): ToolCall | undefined {
    return this.diffs.get(toolId);
  }

  async openDiff(toolId: string): Promise<void> {
    const tool = this.diffs.get(toolId);
    const diff = tool?.diff;
    if (!tool || !diff) {
      void vscode.window.showInformationMessage('dsh-vscode-ok: this tool call did not record a file diff.');
      return;
    }
    if (diff.oldText !== undefined && diff.newText !== undefined) {
      const root = this.storageRoot();
      if (root) {
        const dir = join(root, 'diffs', tool.id.replace(/[^\w.-]+/g, '_'));
        try {
          await mkdir(dir, { recursive: true });
          const before = join(dir, 'before.txt');
          const after = join(dir, 'after.txt');
          await writeFile(before, diff.oldText, 'utf8');
          await writeFile(after, diff.newText, 'utf8');
          const pathLabel = diff.path.replace(/[\\/]+/g, '/');
          await vscode.commands.executeCommand(
            'vscode.diff',
            vscode.Uri.file(before),
            vscode.Uri.file(after),
            `dsh-vscode-ok: ${pathLabel} (before ↔ after)`,
          );
          return;
        } catch {
          // fall through to patch rendering
        }
      }
    }
    const document = await vscode.workspace.openTextDocument({
      content: diff.patch ?? `${diff.path}: +${diff.added} -${diff.removed}`,
      language: 'diff',
    });
    await vscode.window.showTextDocument(document, { preview: true });
  }
}

export async function openFileAt(path: string, line?: number, endLine?: number): Promise<void> {
  const uri = vscode.Uri.file(path);
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, { preview: true });
    if (line !== undefined) {
      const start = new vscode.Position(Math.max(0, line - 1), 0);
      const end = new vscode.Position(Math.max(0, (endLine ?? line) - 1), Number.MAX_SAFE_INTEGER);
      const range = new vscode.Range(start, end);
      editor.selection = new vscode.Selection(start, end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  } catch (error) {
    void vscode.window.showErrorMessage(`dsh-vscode-ok: cannot open ${path}: ${(error as Error).message}`);
  }
}
