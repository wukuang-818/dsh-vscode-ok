import * as vscode from 'vscode';
import type { Attachment } from './shared/protocol';
import { relativePath, truncate } from './util';

const MAX_INLINE_FILE_BYTES = 200_000;

export function fileAttachment(uri: vscode.Uri, root: string | undefined): Attachment | undefined {
  if (uri.scheme !== 'file') {
    return undefined;
  }
  const path = uri.fsPath;
  return {
    kind: 'file',
    label: root ? relativePath(root, path) : path,
    path,
  };
}

export function selectionAttachment(editor: vscode.TextEditor, root: string | undefined): Attachment | undefined {
  const selection = editor.selection;
  if (selection.isEmpty) {
    return undefined;
  }
  const document = editor.document;
  const text = document.getText(selection);
  const startLine = selection.start.line + 1;
  const endLine = selection.end.line + 1;
  const path = document.uri.fsPath;
  const label = root ? relativePath(root, path) : (document.fileName || path);
  return {
    kind: 'selection',
    label: `${label}:${startLine}-${endLine}`,
    path,
    startLine,
    endLine,
    text,
  };
}

export function diagnosticsAttachment(root: string | undefined): Attachment | undefined {
  const editor = vscode.window.activeTextEditor;
  const uri = editor?.document.uri;
  const all = uri ? vscode.languages.getDiagnostics(uri) : [];
  if (!uri || all.length === 0) {
    return undefined;
  }
  const lines = all.slice(0, 50).map((diagnostic) => {
    const line = diagnostic.range.start.line + 1;
    const severity = vscode.DiagnosticSeverity[diagnostic.severity] ?? 'Error';
    return `${severity} ${line}:${diagnostic.range.start.character + 1} ${diagnostic.message}`;
  });
  const label = root ? relativePath(root, uri.fsPath) : uri.fsPath;
  return {
    kind: 'diagnostics',
    label: `Problems in ${label}`,
    path: uri.fsPath,
    text: `${label}\n${lines.join('\n')}`,
  };
}

export function terminalAttachment(): Attachment | undefined {
  const terminal = vscode.window.activeTerminal;
  if (!terminal) {
    return undefined;
  }
  return {
    kind: 'terminal',
    label: `Terminal: ${terminal.name}`,
    text: `Terminal "${terminal.name}" (cwd and output are not captured; run commands to reproduce).`,
  };
}

export function imageAttachment(uri: vscode.Uri, root: string | undefined): Attachment | undefined {
  if (uri.scheme !== 'file') {
    return undefined;
  }
  const ext = uri.fsPath.toLowerCase();
  if (!/\.(png|jpe?g|gif|webp|bmp)$/.test(ext)) {
    return undefined;
  }
  return {
    kind: 'image',
    label: root ? relativePath(root, uri.fsPath) : uri.fsPath,
    path: uri.fsPath,
  };
}

/**
 * Render the prompt that is actually sent to the runtime. Attachments are
 * inlined when they carry text (selections, diagnostics) and referenced by
 * path otherwise, so the agent can read them with its own file tools.
 */
export function buildPromptText(text: string, attachments: Attachment[], root: string | undefined): string {
  const blocks: string[] = [];
  if (text.trim()) {
    blocks.push(text.trim());
  }
  for (const attachment of attachments) {
    const label = root && attachment.path ? relativePath(root, attachment.path) : (attachment.path ?? attachment.label);
    if (attachment.kind === 'selection' && attachment.text) {
      const range =
        attachment.startLine && attachment.endLine ? `#L${attachment.startLine}-L${attachment.endLine}` : '';
      blocks.push(`Selection from ${label}${range}:\n\`\`\`\n${truncate(attachment.text, 40_000)}\n\`\`\``);
    } else if (attachment.kind === 'diagnostics' && attachment.text) {
      blocks.push(`Diagnostics for ${label}:\n${truncate(attachment.text, 20_000)}`);
    } else if (attachment.kind === 'terminal' && attachment.text) {
      blocks.push(attachment.text);
    } else if (attachment.kind === 'image' && attachment.path) {
      blocks.push(`Image attached at ${label}.`);
    } else if (attachment.path) {
      blocks.push(`File: ${label}`);
    } else if (attachment.text) {
      blocks.push(`${attachment.label}:\n${truncate(attachment.text, 20_000)}`);
    }
  }
  return blocks.join('\n\n');
}

/** Read a file for cases where the runtime has no file tools (fallback). */
export async function readFileForPrompt(uri: vscode.Uri): Promise<Attachment | undefined> {
  if (uri.scheme !== 'file') {
    return undefined;
  }
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > MAX_INLINE_FILE_BYTES) {
      return undefined;
    }
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(bytes).toString('utf8');
    return {
      kind: 'file',
      label: vscode.workspace.asRelativePath(uri),
      path: uri.fsPath,
      text,
    };
  } catch {
    return undefined;
  }
}
