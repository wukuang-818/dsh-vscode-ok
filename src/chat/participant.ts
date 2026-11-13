import * as vscode from 'vscode';
import type { AgentEvent, Attachment, ChatState } from '../shared/protocol';
import { log } from '../log';
import { relativePath } from '../util';
import type { ChatController } from './controller';

export const PARTICIPANT_ID = 'dsh';

function stateSummary(state: ChatState): string {
  const backend =
    state.backend.status === 'ready'
      ? `ready${state.backend.reused ? ' (attached)' : ''}`
      : state.backend.status;
  const model = state.session.model?.label ?? 'default model';
  const lines = [
    `- Backend: **${backend}**`,
    `- Workspace: \`${state.workspace.name}\``,
    `- Session: \`${state.session.id ?? 'none'}\``,
    `- Model: ${model}`,
    `- Permission: \`${state.session.permission}\``,
    `- Agent preset: \`${state.session.agentPreset ?? 'default'}\``,
  ];
  return lines.join('\n');
}

function referencesToAttachments(
  references: ReadonlyArray<vscode.ChatPromptReference>,
  root: string | undefined,
): Attachment[] {
  const attachments: Attachment[] = [];
  for (const reference of references) {
    const value = reference.value;
    if (value instanceof vscode.Uri && value.scheme === 'file') {
      const path = value.fsPath;
      attachments.push({
        kind: 'file',
        label: root ? relativePath(root, path) : path,
        path,
      });
    } else if (value instanceof vscode.Location) {
      const path = value.uri.fsPath;
      attachments.push({
        kind: 'file',
        label: root ? relativePath(root, path) : path,
        path,
        startLine: value.range.start.line + 1,
        endLine: value.range.end.line + 1,
      });
    } else if (typeof value === 'string') {
      attachments.push({ kind: 'selection', label: reference.id, text: value });
    }
  }
  return attachments;
}

export function registerChatParticipant(controller: ChatController): vscode.Disposable {
  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, async (request, context, response, token) => {
    const state = controller.getState();
    const root = state.workspace.cwd;
    const command = request.command?.trim().toLowerCase();

    if (command === 'new') {
      await controller.newSession();
      response.markdown('Started a new session.');
      return { metadata: { command: 'new' } };
    }
    if (command === 'status') {
      response.markdown(stateSummary(controller.getState()));
      return { metadata: { command: 'status' } };
    }
    if (command === 'model') {
      await controller.pickModel();
      return { metadata: { command: 'model' } };
    }
    if (command === 'permission') {
      await controller.pickPermission();
      return { metadata: { command: 'permission' } };
    }
    if (command === 'agent') {
      await controller.pickAgentPreset();
      return { metadata: { command: 'agent' } };
    }
    if (command === 'sessions') {
      await controller.requestSessions();
      const sessions = controller.getState().sessions;
      if (sessions.length === 0) {
        response.markdown('No saved sessions yet.');
        return { metadata: { command: 'sessions' } };
      }
      response.markdown(
        sessions
          .slice(0, 20)
          .map((session) => `- \`${session.id}\` ${session.title}`)
          .join('\n'),
      );
      return { metadata: { command: 'sessions' } };
    }
    if (command === 'compact') {
      response.markdown(
        'Context compaction is handled by the agent runtime. Use the dsh-vscode-ok sidebar for full session controls.',
      );
      return { metadata: { command: 'compact' } };
    }

    const text = request.prompt.trim();
    if (!text) {
      response.markdown('Ask the agent something, or pass a file reference with `@path`.');
      return {};
    }

    const attachments: Attachment[] = referencesToAttachments(request.references, root);
    const cancelListener = token.onCancellationRequested(() => {
      void controller.stopGeneration();
    });

    let assistantId: string | undefined;
    const streamedParts = new Set<number>();
    let settled = false;
    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const settle = () => {
      if (!settled) {
        settled = true;
        resolveDone();
      }
    };
    const warn = (message: string): void => {
      response.markdown(`\n\n> Warning: ${message}\n\n`);
    };

    const subscription = controller.onAgentEvent((event: AgentEvent) => {
      if (event.type === 'message-start' && event.message.role === 'assistant') {
        assistantId ??= event.message.id;
        return;
      }
      if (event.type === 'part' && assistantId && event.messageId === assistantId) {
        if (event.part.type === 'text' && !streamedParts.has(event.index)) {
          streamedParts.add(event.index);
          const text = event.part.text;
          if (text) {
            response.markdown(text);
          }
        } else if (event.part.type === 'reasoning' && event.part.text) {
          response.progress(event.part.text);
        }
        return;
      }
      if (event.type === 'delta' && assistantId && event.messageId === assistantId) {
        response.markdown(event.text);
        return;
      }
      if (event.type === 'tool') {
        response.progress(`${event.tool.title} (${event.tool.status})`);
        return;
      }
      if (event.type === 'approval' && event.request) {
        warn(
          `Approval needed for ${event.request.toolName}: ${event.request.title}. Answer in the dsh-vscode-ok sidebar.`,
        );
        void controller.focus();
        return;
      }
      if (event.type === 'notice') {
        if (event.level === 'error') {
          warn(event.text);
        } else {
          response.progress(event.text);
        }
        return;
      }
      if (event.type === 'message-status' && assistantId && event.messageId === assistantId) {
        if (event.status === 'error') {
          warn(event.error ?? 'The run failed.');
        }
        if (event.status !== 'streaming') {
          settle();
        }
      }
      if (event.type === 'backend-exit') {
        warn(event.error ?? 'The agent runtime exited.');
        settle();
      }
    });

    try {
      await controller.sendPrompt(text, attachments);
      const timeout = setTimeout(settle, controller.getConfig().commandTimeoutMs);
      await done;
      clearTimeout(timeout);
    } catch (error) {
      warn(error instanceof Error ? error.message : String(error));
    } finally {
      subscription.dispose();
      cancelListener.dispose();
      void log('chat participant turn finished');
    }
    return { metadata: { sessionId: controller.getState().session.id ?? undefined } };
  });

  participant.iconPath = vscode.Uri.joinPath(
    // Extension root is not known here; relative path resolves from dist/../media.
    vscode.Uri.file(__dirname),
    '..',
    '..',
    'media',
    'dsh.svg',
  );
  participant.followupProvider = {
    provideFollowups() {
      return [
        {
          prompt: '@dsh /status',
          label: 'Show status',
          command: 'status',
        },
        {
          prompt: '@dsh /new',
          label: 'Start a new session',
          command: 'new',
        },
      ];
    },
  };
  return participant;
}
