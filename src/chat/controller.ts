import * as vscode from 'vscode';
import type {
  AgentEvent,
  Attachment,
  ChatMessage,
  ChatPart,
  ChatState,
  HostMessage,
  ModelInfo,
  PermissionPreset,
  SessionInfo,
  SessionSummary,
  ToolCall,
} from '../shared/protocol';
import { readConfig, workspaceInfo, type ExtensionConfig } from '../config';
import { log } from '../log';
import { errorMessage, uid } from '../util';
import type { Backend } from '../dsh/backend';

export type WebviewSink = (message: HostMessage) => void;

interface RegisteredView {
  sink: WebviewSink;
  visible: boolean;
}

function emptySession(config: ExtensionConfig): SessionInfo {
  return {
    id: null,
    title: '',
    model: null,
    permission: config.permissionPreset,
    agentPreset: config.agentPreset || null,
    running: false,
  };
}

function findTextPart(message: ChatMessage, index: number): ChatPart | undefined {
  return message.parts[index];
}

export interface SendResult {
  userMessageId: string;
}

/**
 * Owns the conversation state shared by the chat webview, the native chat
 * participant and the commands. All backend events flow through here.
 */
export class ChatController implements vscode.Disposable {
  private readonly views = new Set<RegisteredView>();
  private readonly emitter = new vscode.EventEmitter<AgentEvent>();
  readonly onAgentEvent = this.emitter.event;

  private backendInstance: Backend | undefined;
  private state: ChatState;
  private config: ExtensionConfig;
  private starting: Promise<void> | undefined;
  private activeTurn: { userMessageId: string; assistantMessageId?: string } | undefined;
  private currentApproval: import('../shared/protocol').ApprovalRequest | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly createBackend: (emit: (event: AgentEvent) => void) => Backend) {
    this.config = readConfig();
    this.state = {
      workspace: workspaceInfo(),
      backend: { status: 'stopped' },
      session: emptySession(this.config),
      messages: [],
      tools: {},
      sessions: [],
      models: [],
      agentPresets: [],
      config: {
        includeDiagnostics: this.config.includeDiagnostics,
        confirmBeforeSend: this.config.confirmBeforeSend,
      },
    };
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('dsh')) {
          this.refreshConfig();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.state.workspace = workspaceInfo();
        this.post({ type: 'state', patch: { workspace: this.state.workspace } });
      }),
    );
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.emitter.dispose();
  }

  /* ---------------------------------------------------------------- */
  /* Views                                                            */
  /* ---------------------------------------------------------------- */

  attachView(sink: WebviewSink): vscode.Disposable {
    const view: RegisteredView = { sink, visible: true };
    this.views.add(view);
    return new vscode.Disposable(() => this.views.delete(view));
  }

  setViewVisible(visible: boolean): void {
    const last = [...this.views].pop();
    if (last) {
      last.visible = visible;
    }
  }

  get viewVisible(): boolean {
    return [...this.views].some((view) => view.visible);
  }

  post(message: HostMessage): void {
    for (const view of this.views) {
      try {
        view.sink(message);
      } catch (error) {
        log('failed to post to webview:', errorMessage(error));
      }
    }
  }

  sendInit(): void {
    this.post({ type: 'init', state: this.state });
  }

  getState(): ChatState {
    return this.state;
  }

  getConfig(): ExtensionConfig {
    return this.config;
  }

  refreshConfig(): void {
    this.config = readConfig();
    this.state.config = {
      includeDiagnostics: this.config.includeDiagnostics,
      confirmBeforeSend: this.config.confirmBeforeSend,
    };
    this.post({ type: 'state', patch: { config: this.state.config } });
  }

  async focus(): Promise<void> {
    try {
      await vscode.commands.executeCommand('dsh.chatView.focus');
    } catch {
      await vscode.commands.executeCommand('workbench.view.extension.dshSidebar');
    }
  }

  /* ---------------------------------------------------------------- */
  /* Backend lifecycle                                                */
  /* ---------------------------------------------------------------- */

  private get backend(): Backend {
    if (!this.backendInstance) {
      this.backendInstance = this.createBackend((event) => this.handleEvent(event));
    }
    return this.backendInstance;
  }

  get backendKind(): string {
    return this.backendInstance?.kind ?? '';
  }

  async ensureStarted(): Promise<void> {
    if (this.backendInstance?.isReady()) {
      return;
    }
    if (this.starting) {
      return this.starting;
    }
    const starting = (async () => {
      this.setBackend('starting', 'Starting the agent runtime…');
      try {
        await this.backend.start();
      } catch (error) {
        const message = errorMessage(error);
        log('backend start failed:', message);
        this.setBackend('error', message);
        throw error;
      } finally {
        this.starting = undefined;
      }
    })();
    this.starting = starting;
    return starting;
  }

  async restart(): Promise<void> {
    try {
      await this.backendInstance?.stop();
    } catch (error) {
      log('backend stop failed:', errorMessage(error));
    }
    this.backendInstance = undefined;
    this.setBackend('stopped', 'Restarting…');
    this.state.messages = [];
    this.state.tools = {};
    this.post({ type: 'clear' });
    await this.ensureStarted();
  }

  async stop(): Promise<void> {
    await this.backendInstance?.stop();
    this.backendInstance = undefined;
    this.setBackend('stopped');
  }

  private setBackend(status: ChatState['backend']['status'], detail?: string, reused?: boolean): void {
    this.state.backend = { status, detail, reused };
    this.post({ type: 'backend', status, detail, reused });
  }

  /* ---------------------------------------------------------------- */
  /* Prompting                                                        */
  /* ---------------------------------------------------------------- */

  async sendPrompt(text: string, attachments: Attachment[] = []): Promise<SendResult | undefined> {
    const prompt = text.trim();
    if (!prompt && attachments.length === 0) {
      return undefined;
    }
    await this.ensureStarted();

    const userMessage: ChatMessage = {
      id: uid('user'),
      role: 'user',
      createdAt: Date.now(),
      status: 'done',
      parts: [{ type: 'text', text: prompt }],
      attachments: attachments.length > 0 ? attachments : undefined,
    };
    this.state.messages.push(userMessage);
    this.post({ type: 'message', message: userMessage });

    this.activeTurn = { userMessageId: userMessage.id };
    this.state.session.running = true;
    this.post({ type: 'session', session: this.state.session });

    try {
      await this.backend.send({ text: prompt, attachments });
    } catch (error) {
      const message = errorMessage(error);
      log('send failed:', message);
      this.appendAssistantNotice('error', `Failed to send prompt: ${message}`);
      this.state.session.running = false;
      this.post({ type: 'session', session: this.state.session });
      throw error;
    }
    return { userMessageId: userMessage.id };
  }

  async stopGeneration(): Promise<void> {
    try {
      await this.backend.interrupt();
    } catch (error) {
      log('interrupt failed:', errorMessage(error));
    }
  }

  async newSession(): Promise<void> {
    this.state.messages = [];
    this.state.tools = {};
    this.state.session = emptySession(this.config);
    this.currentApproval = undefined;
    this.post({ type: 'clear' });
    this.post({ type: 'session', session: this.state.session });
    try {
      await this.backend.newSession();
    } catch (error) {
      log('new session failed:', errorMessage(error));
    }
  }

  async switchSession(sessionId: string): Promise<void> {
    try {
      await this.ensureStarted();
      await this.backend.switchSession(sessionId);
    } catch (error) {
      log('switch session failed:', errorMessage(error));
    }
  }

  async requestSessions(): Promise<void> {
    try {
      await this.ensureStarted();
      const sessions = await this.backend.listSessions();
      this.state.sessions = sessions;
      this.post({ type: 'sessions', sessions });
    } catch (error) {
      log('list sessions failed:', errorMessage(error));
    }
  }

  async pickModelFromWebview(): Promise<void> {
    await this.pickModel();
  }

  async pickModel(): Promise<void> {
    await this.ensureStarted();
    let models = this.state.models;
    if (models.length === 0 && this.backend.listModels) {
      try {
        models = await this.backend.listModels();
        this.state.models = models;
        this.post({ type: 'models', models });
      } catch (error) {
        log('list models failed:', errorMessage(error));
      }
    }
    if (models.length === 0) {
      void vscode.window.showWarningMessage('The backend has not reported any models yet.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      models.map((model) => ({
        label: model.label,
        description: model.description,
        detail: model.id,
        id: model.id,
      })),
      { title: 'Select model', placeHolder: this.state.session.model?.label ?? 'Model' },
    );
    if (!picked) {
      return;
    }
    try {
      await this.backend.setModel(picked.id);
    } catch (error) {
      void vscode.window.showErrorMessage(`dsh-vscode-ok: failed to switch model: ${errorMessage(error)}`);
    }
  }

  async pickPermission(): Promise<void> {
    const { PERMISSION_PRESETS } = await import('../shared/protocol');
    const picked = await vscode.window.showQuickPick(
      PERMISSION_PRESETS.map((preset) => ({
        label: preset.label,
        detail: preset.id,
        description: preset.description,
        id: preset.id,
      })),
      { title: 'Permission mode', placeHolder: this.state.session.permission },
    );
    if (!picked) {
      return;
    }
    await this.setPermission(picked.id);
  }

  async setPermission(preset: PermissionPreset): Promise<void> {
    this.state.session.permission = preset;
    this.post({ type: 'session', session: this.state.session });
    try {
      await this.ensureStarted();
      await this.backend.setPermission(preset);
    } catch (error) {
      log('set permission failed:', errorMessage(error));
    }
  }

  async pickAgentPreset(): Promise<void> {
    await this.ensureStarted();
    let presets = this.state.agentPresets;
    if (presets.length === 0 && this.backend.listAgentPresets) {
      try {
        presets = await this.backend.listAgentPresets();
        this.state.agentPresets = presets;
        this.post({ type: 'agent-presets', presets });
      } catch (error) {
        log('list agent presets failed:', errorMessage(error));
      }
    }
    if (presets.length === 0) {
      void vscode.window.showWarningMessage('The backend has not reported any agent presets yet.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      presets.map((preset) => ({
        label: preset.name,
        description: preset.description,
        detail: preset.id,
        id: preset.id,
      })),
      { title: 'Agent preset' },
    );
    if (!picked) {
      return;
    }
    try {
      await this.backend.setAgentPreset(picked.id);
    } catch (error) {
      void vscode.window.showErrorMessage(`dsh-vscode-ok: failed to switch agent preset: ${errorMessage(error)}`);
    }
  }

  async answerApproval(approvalId: string, optionId: string): Promise<void> {
    this.currentApproval = undefined;
    this.post({ type: 'approval', request: null });
    try {
      await this.backend.answerApproval(approvalId, optionId);
    } catch (error) {
      log('approval failed:', errorMessage(error));
    }
  }

  /* ---------------------------------------------------------------- */
  /* Event handling                                                   */
  /* ---------------------------------------------------------------- */

  private handleEvent(event: AgentEvent): void {
    try {
      this.applyEvent(event);
    } catch (error) {
      log('failed to apply agent event:', errorMessage(error), event.type);
    }
    try {
      this.emitter.fire(event);
    } catch (error) {
      log('agent event listener failed:', errorMessage(error));
    }
  }

  private applyEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'backend-ready': {
        this.setBackend('ready', event.detail, this.state.backend.reused);
        break;
      }
      case 'backend-exit': {
        this.setBackend('error', event.error ?? `The agent runtime exited (code ${event.code ?? '?'})`);
        this.state.session.running = false;
        this.post({ type: 'session', session: this.state.session });
        break;
      }
      case 'session': {
        const previousId = this.state.session.id;
        this.state.session = { ...this.state.session, ...event.session };
        this.post({ type: 'session', session: this.state.session });
        if (previousId !== this.state.session.id) {
          this.refreshConfig();
        }
        break;
      }
      case 'sessions': {
        this.state.sessions = event.sessions;
        this.post({ type: 'sessions', sessions: event.sessions });
        break;
      }
      case 'models': {
        this.state.models = event.models;
        this.post({ type: 'models', models: event.models });
        break;
      }
      case 'agent-presets': {
        this.state.agentPresets = event.presets;
        this.post({ type: 'agent-presets', presets: event.presets });
        break;
      }
      case 'message-start': {
        const existing = this.state.messages.find((message) => message.id === event.message.id);
        if (!existing) {
          this.state.messages.push(event.message);
          this.post({ type: 'message', message: event.message });
        }
        if (event.message.role === 'assistant' && this.activeTurn) {
          this.activeTurn.assistantMessageId = event.message.id;
        }
        break;
      }
      case 'part': {
        const message = this.ensureMessage(event.messageId, 'assistant');
        if (!message) {
          break;
        }
        message.parts[event.index] = event.part;
        this.post({ type: 'part', messageId: event.messageId, index: event.index, part: event.part });
        break;
      }
      case 'delta': {
        const message = this.ensureMessage(event.messageId, 'assistant');
        if (!message) {
          break;
        }
        const part = findTextPart(message, event.index);
        if (part && (part.type === 'text' || part.type === 'reasoning')) {
          part.text += event.text;
          this.post({ type: 'delta', messageId: event.messageId, index: event.index, text: event.text });
        }
        break;
      }
      case 'message-status': {
        const message = this.state.messages.find((candidate) => candidate.id === event.messageId);
        if (message) {
          message.status = event.status;
          if (event.error) {
            message.error = event.error;
          }
        }
        this.post({
          type: 'message-status',
          messageId: event.messageId,
          status: event.status,
          error: event.error,
        });
        if (event.status !== 'streaming') {
          this.state.session.running = false;
          this.post({ type: 'session', session: this.state.session });
          if (this.activeTurn?.assistantMessageId === event.messageId) {
            this.activeTurn = undefined;
          }
        }
        break;
      }
      case 'tool': {
        this.state.tools[event.tool.id] = event.tool;
        this.post({ type: 'tool', tool: event.tool });
        break;
      }
      case 'approval': {
        this.currentApproval = event.request ?? undefined;
        this.post({ type: 'approval', request: event.request });
        if (event.request) {
          void this.surfaceApproval(event.request);
        }
        break;
      }
      case 'notice': {
        this.appendAssistantNotice(event.level, event.text);
        break;
      }
      case 'log': {
        log(event.text);
        break;
      }
      default:
        break;
    }
  }

  private async surfaceApproval(request: import('../shared/protocol').ApprovalRequest): Promise<void> {
    if (this.viewVisible) {
      return;
    }
    const items = request.options.map((option) => option.label);
    const picked = await vscode.window.showWarningMessage(
      `Approval needed: ${request.title}${request.detail ? `\n\n${request.detail}` : ''}`,
      { modal: true },
      ...items,
    );
    if (picked) {
      const option = request.options.find((candidate) => candidate.label === picked);
      if (option) {
        await this.answerApproval(request.id, option.id);
        return;
      }
    }
    void this.focus();
  }

  private ensureMessage(messageId: string, role: 'assistant' | 'user'): ChatMessage | undefined {
    const existing = this.state.messages.find((message) => message.id === messageId);
    if (existing) {
      return existing;
    }
    const created: ChatMessage = {
      id: messageId,
      role,
      createdAt: Date.now(),
      parts: [],
      status: 'streaming',
    };
    this.state.messages.push(created);
    this.post({ type: 'message', message: created });
    if (role === 'assistant' && this.activeTurn) {
      this.activeTurn.assistantMessageId = messageId;
    }
    return created;
  }

  private appendAssistantNotice(level: 'info' | 'warning' | 'error', text: string): void {
    const turnMessageId = this.activeTurn?.assistantMessageId;
    const target =
      (turnMessageId && this.state.messages.find((message) => message.id === turnMessageId)) ||
      [...this.state.messages].reverse().find((message) => message.role === 'assistant');
    if (target) {
      target.parts.push({ type: 'notice', level, text });
      this.post({ type: 'notice', level, text });
    } else {
      this.post({ type: 'toast', level, text });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Webview messages                                                 */
  /* ---------------------------------------------------------------- */

  async handleWebviewMessage(message: import('../shared/protocol').WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready': {
        this.sendInit();
        break;
      }
      case 'send': {
        try {
          await this.sendPrompt(message.text, message.attachments);
        } catch {
          // Already surfaced as a notice.
        }
        break;
      }
      case 'stop': {
        await this.stopGeneration();
        break;
      }
      case 'new-session': {
        await this.newSession();
        break;
      }
      case 'switch-session': {
        await this.switchSession(message.sessionId);
        break;
      }
      case 'request-sessions': {
        await this.requestSessions();
        break;
      }
      case 'pick-model': {
        await this.pickModel();
        break;
      }
      case 'pick-permission': {
        await this.pickPermission();
        break;
      }
      case 'pick-agent': {
        await this.pickAgentPreset();
        break;
      }
      case 'approval': {
        await this.answerApproval(message.id, message.optionId);
        break;
      }
      case 'open-file': {
        await vscode.commands.executeCommand('dsh.openFileAt', message.path, message.line, message.endLine);
        break;
      }
      case 'open-diff': {
        await vscode.commands.executeCommand('dsh.openToolDiff', message.toolId);
        break;
      }
      case 'copy': {
        await vscode.env.clipboard.writeText(message.text);
        break;
      }
      case 'attach-files': {
        await vscode.commands.executeCommand('dsh.addFileToChat');
        break;
      }
      case 'attach-selection': {
        await vscode.commands.executeCommand('dsh.sendSelection');
        break;
      }
      case 'attach-problems': {
        await vscode.commands.executeCommand('dsh.attachProblems');
        break;
      }
      case 'remove-attachment': {
        break;
      }
      case 'restart-backend': {
        await this.restart();
        break;
      }
      case 'start-backend': {
        try {
          await this.ensureStarted();
        } catch {
          // Status already shows the failure.
        }
        break;
      }
      case 'show-logs': {
        await vscode.commands.executeCommand('dsh.showLogs');
        break;
      }
      case 'open-settings': {
        await vscode.commands.executeCommand('dsh.openSettings');
        break;
      }
      case 'copy-session-id': {
        if (this.state.session.id) {
          await vscode.env.clipboard.writeText(this.state.session.id);
        }
        break;
      }
      default:
        break;
    }
  }

  /** Attach files/selection picked by a command into the composer. */
  addComposerAttachments(attachments: Attachment[], text = ''): void {
    this.post({ type: 'composer', text, attachments });
    void this.focus();
  }

  getSessionSummary(): SessionSummary | undefined {
    if (!this.state.session.id) {
      return undefined;
    }
    return {
      id: this.state.session.id,
      title: this.state.session.title || 'Untitled session',
      running: this.state.session.running,
    };
  }

  getModels(): ModelInfo[] {
    return this.state.models;
  }
}
