/**
 * Webview entry point: VS Code API bridge, host message dispatch, app shell.
 */

import './styles.css';

import type { BackendStatus, HostMessage, WebviewMessage } from '../shared/protocol';
import type { JSX } from 'preact';
import { render } from 'preact';
import { useEffect, useReducer, useRef, useState } from 'preact/hooks';
import { ApprovalDialog } from './components/ApprovalDialog';
import { Composer } from './components/Composer';
import { EmptyState } from './components/EmptyState';
import { Header } from './components/Header';
import { SessionPicker } from './components/SessionPicker';
import { Transcript } from './components/Transcript';
import { CrossIcon } from './icons';
import {
  createInitialState,
  reduceApp,
  removeDraftAttachment,
  selectDismissOption,
  type Draft,
} from './state';

/* ------------------------------------------------------------------ */
/* VS Code host bridge                                                 */
/* ------------------------------------------------------------------ */

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

function createApi(): VsCodeApi {
  if (typeof acquireVsCodeApi === 'function') return acquireVsCodeApi();
  // Plain-browser fallback: keep rendering so layout work does not need VS Code.
  return { postMessage: () => undefined };
}

const vscode = createApi();

function post(message: WebviewMessage): void {
  vscode.postMessage(message);
}

const HOST_MESSAGE_TYPES: ReadonlySet<string> = new Set<HostMessage['type']>([
  'init',
  'state',
  'backend',
  'session',
  'sessions',
  'models',
  'agent-presets',
  'clear',
  'message',
  'part',
  'delta',
  'message-status',
  'tool',
  'approval',
  'notice',
  'focus-composer',
  'composer',
  'toast',
]);

function isHostMessage(value: unknown): value is HostMessage {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && HOST_MESSAGE_TYPES.has(type);
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

const TOAST_TIMEOUT_MS = 6000;

function App(): JSX.Element {
  const [state, dispatch] = useReducer(reduceApp, undefined, createInitialState);
  const [draft, setDraft] = useState<Draft>({ text: '', attachments: [] });
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hadApproval = useRef(false);

  const chat = state.chat;
  const approval = state.approval;

  /* host -> webview */
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const data: unknown = event.data;
      if (isHostMessage(data)) dispatch({ type: 'host', message: data });
    };
    window.addEventListener('message', onMessage);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  /* composer prefill from host */
  useEffect(() => {
    const fill = state.composerFill;
    if (!fill) return;
    setDraft((previous) => ({ text: fill.text, attachments: fill.attachments ?? previous.attachments }));
    textareaRef.current?.focus();
  }, [state.composerSeq]);

  /* explicit focus requests */
  useEffect(() => {
    if (state.focusRequest > 0) textareaRef.current?.focus();
  }, [state.focusRequest]);

  /* auto-dismiss toasts */
  useEffect(() => {
    if (state.toasts.length === 0) return;
    const timers = state.toasts.map((toast) =>
      window.setTimeout(() => dispatch({ type: 'dismiss-toast', id: toast.id }), TOAST_TIMEOUT_MS),
    );
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [state.toasts]);

  /* return focus to the composer once an approval is answered */
  useEffect(() => {
    if (approval) {
      hadApproval.current = true;
    } else if (hadApproval.current) {
      hadApproval.current = false;
      textareaRef.current?.focus();
    }
  }, [approval]);

  /* webview -> host */
  const send = (): void => {
    const text = draft.text.trim();
    const attachments = draft.attachments ?? [];
    if (text === '' && attachments.length === 0) return;
    post({ type: 'send', text, attachments });
    setDraft({ text: '', attachments: [] });
    textareaRef.current?.focus();
  };

  const stop = (): void => {
    post({ type: 'stop' });
  };

  const newChat = (): void => {
    setDraft({ text: '', attachments: [] });
    post({ type: 'new-session' });
    textareaRef.current?.focus();
  };

  const openSessions = (): void => {
    setSessionsOpen(true);
    post({ type: 'request-sessions' });
  };

  const closeSessions = (): void => {
    setSessionsOpen(false);
    textareaRef.current?.focus();
  };

  const pickSession = (sessionId: string): void => {
    setSessionsOpen(false);
    setDraft({ text: '', attachments: [] });
    post({ type: 'switch-session', sessionId });
    textareaRef.current?.focus();
  };

  const startBackend = (): void => {
    if (chat?.backend.status === 'error') post({ type: 'restart-backend' });
    else post({ type: 'start-backend' });
  };

  const answerApproval = (approvalId: string, optionId: string): void => {
    post({ type: 'approval', id: approvalId, optionId });
    dispatch({ type: 'approval-answer' });
    textareaRef.current?.focus();
  };

  const openDiff = (toolId: string): void => {
    post({ type: 'open-diff', toolId });
  };

  const openFile = (path: string, line?: number, endLine?: number): void => {
    post({ type: 'open-file', path, line, endLine });
  };

  const copy = (text: string): void => {
    post({ type: 'copy', text });
  };

  const removeAttachment = (index: number): void => {
    setDraft((previous) => removeDraftAttachment(previous, index));
    post({ type: 'remove-attachment', index });
  };

  const useExample = (text: string): void => {
    setDraft((previous) => ({ ...previous, text }));
    textareaRef.current?.focus();
  };

  /* overlays close on Escape (approval first: it is modal) */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (approval) {
        event.preventDefault();
        answerApproval(approval.id, selectDismissOption(approval));
        return;
      }
      if (sessionsOpen) {
        event.preventDefault();
        setSessionsOpen(false);
        textareaRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [approval, sessionsOpen]);

  const backendStatus: BackendStatus = chat ? chat.backend.status : 'starting';
  const running = chat ? chat.session.running : false;
  const answerOption = approval
    ? (optionId: string): void => answerApproval(approval.id, optionId)
    : null;

  let body: JSX.Element;
  if (chat === null) {
    body = (
      <div class="loading" role="status">
        <span class="working-dot" aria-hidden="true" />
        <span>Loading dsh-vscode-ok…</span>
      </div>
    );
  } else if (chat.messages.length === 0) {
    body = (
      <EmptyState
        backendStatus={chat.backend.status}
        backendDetail={chat.backend.detail}
        onStart={startBackend}
        onRestart={startBackend}
        onUseExample={useExample}
      />
    );
  } else {
    body = (
      <Transcript
        chat={chat}
        approval={approval}
        onOpenDiff={openDiff}
        onOpenFile={openFile}
        onCopy={copy}
        onApproval={answerApproval}
      />
    );
  }

  return (
    <div class="app">
      <Header
        chat={chat}
        onNewChat={newChat}
        onOpenSessions={openSessions}
        onStop={stop}
        onSettings={() => post({ type: 'open-settings' })}
        onPickModel={() => post({ type: 'pick-model' })}
        onPickPermission={() => post({ type: 'pick-permission' })}
        onPickAgent={() => post({ type: 'pick-agent' })}
        onStartBackend={startBackend}
      />
      <main class="chat-main">{body}</main>
      <Composer
        draft={draft}
        backendStatus={backendStatus}
        running={running}
        textareaRef={textareaRef}
        onTextChange={(text) => setDraft((previous) => ({ ...previous, text }))}
        onSend={send}
        onStop={stop}
        onAttachFiles={() => post({ type: 'attach-files' })}
        onAttachSelection={() => post({ type: 'attach-selection' })}
        onAttachProblems={() => post({ type: 'attach-problems' })}
        onRemoveAttachment={removeAttachment}
      />
      {sessionsOpen && (
        <SessionPicker
          sessions={chat ? chat.sessions : []}
          activeId={chat ? chat.session.id : null}
          onPick={pickSession}
          onClose={closeSessions}
        />
      )}
      {approval && answerOption && <ApprovalDialog request={approval} onAnswer={answerOption} />}
      <div class="toasts" role="status" aria-live="polite">
        {state.toasts.map((toast) => (
          <div class={`toast toast-${toast.level}`} key={toast.id}>
            <span class="toast-text">{toast.text}</span>
            <button
              type="button"
              class="icon-btn icon-btn-small"
              title="Dismiss"
              aria-label="Dismiss notification"
              onClick={() => dispatch({ type: 'dismiss-toast', id: toast.id })}
            >
              <CrossIcon size={10} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Mount                                                               */
/* ------------------------------------------------------------------ */

const root = document.getElementById('root');
if (root) render(<App />, root);
