import * as vscode from 'vscode';
import { uid } from '../util';
import type { ChatController } from './controller';

const VIEW_TYPE = 'dsh.chatView';

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = VIEW_TYPE;

  private view: vscode.WebviewView | undefined;
  private disposeView: vscode.Disposable | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: ChatController,
  ) {}

  dispose(): void {
    this.disposeView?.dispose();
    this.disposeView = undefined;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const webview = view.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
        vscode.Uri.joinPath(this.extensionUri, 'media'),
      ],
    };
    webview.html = this.renderHtml(webview);

    this.disposeView?.dispose();
    const sink = (message: unknown) => {
      void webview.postMessage(message);
    };
    const attachment = this.controller.attachView(sink);
    const visibility = view.onDidChangeVisibility(() => {
      this.controller.setViewVisible(view.visible);
    });
    this.disposeView = new vscode.Disposable(() => {
      attachment.dispose();
      visibility.dispose();
    });
    this.controller.setViewVisible(view.visible);

    webview.onDidReceiveMessage(
      (message: import('../shared/protocol').WebviewMessage) => {
        void this.controller.handleWebviewMessage(message);
      },
      undefined,
      [],
    );

    view.onDidDispose(() => {
      this.disposeView?.dispose();
      this.disposeView = undefined;
      this.view = undefined;
    });
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = uid('nonce');
    const root = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(root, 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(root, 'main.css'));
    const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.html');

    let html = '';
    try {
      html = Buffer.from(this.readFile(htmlPath)).toString('utf8');
    } catch {
      html = '';
    }
    if (!html) {
      html = DEFAULT_HTML;
    }
    return html
      .replaceAll('{{cspSource}}', webview.cspSource)
      .replaceAll('{{nonce}}', nonce)
      .replaceAll('{{scriptUri}}', scriptUri.toString())
      .replaceAll('{{styleUri}}', styleUri.toString());
  }

  private readFile(uri: vscode.Uri): Uint8Array {
    // Synchronous read keeps resolveWebviewView simple; the file is tiny.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    return readFileSync(uri.fsPath);
  }
}

const DEFAULT_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src {{cspSource}} data: https:; style-src {{cspSource}} 'unsafe-inline'; script-src 'nonce-{{nonce}}';" />
    <link rel="stylesheet" href="{{styleUri}}" />
    <title>dsh-vscode-ok</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="{{nonce}}" src="{{scriptUri}}"></script>
  </body>
</html>`;
