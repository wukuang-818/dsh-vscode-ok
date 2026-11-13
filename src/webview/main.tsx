/**
 * Webview entry point: VS Code API bridge, host message dispatch, app shell.
 *
 * Streaming traffic is coalesced into one commit per animation frame; control
 * messages that change what the reader can do (init, clear, approval, …) flush
 * the queue and apply immediately so ordering stays strict.
 */

import './styles.css';

import type { BackendStatus, HostMessage, WebviewMessage } from '../shared/protocol';
import type { JSX } from 'preact';
import { render } from 'preact';
import { useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import { Composer } from './components/Composer';
import { Header } from './components/Header';
import { PlanPanel } from './components/PlanPanel';
import { SessionPicker } from './components/SessionPicker';
import { Transcript } from './components/Transcript';
import { CrossIcon } from './icons';
import { selectPlan } from './plan';
import {
  createInitialState,
  reduceApp,
  removeDraftAttachment,
  selectDismissOption,
  selectSessionSearch,
  selectUsage,
  type Draft,
} from './state';
import { extractMentions, mergeMentionAttachments } from './util';

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
  'files',
  'commands',
  'skills',
  'search-results',
]);

/**
 * Token-stream traffic: many messages per frame, so one commit per frame is
 * enough. Everything else is a control message and must not wait.
 */
const DEFERRED_HOST_TYPES: ReadonlySet<string> = new Set<HostMessage['type']>([
  'message',
  'delta',
  'part',
  'tool',
  'state',
  'notice',
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
  const pendingRef = useRef<HostMessage[]>([]);
  const frameRef = useRef<number | null>(null);

  const chat = state.chat;
  const approval = state.approval;

  /* host -> webview */
  useEffect(() => {
    const cancelFrame = (): void => {
      if (frameRef.current === null) return;
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };

    const apply = (message: HostMessage): void => {
      dispatch({ type: 'host', message });
    };

    /** Drain the queue in order, then cancel any scheduled frame. */
    const flush = (): void => {
      cancelFrame();
      const queued = pendingRef.current;
      pendingRef.current = [];
      for (const queuedMessage of queued) apply(queuedMessage);
    };

    const schedule = (): void => {
      if (frameRef.current !== null) return;
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        const queued = pendingRef.current;
        pendingRef.current = [];
        for (const queuedMessage of queued) apply(queuedMessage);
      });
    };

    const onMessage = (event: MessageEvent): void => {
      const data: unknown = event.data;
      if (!isHostMessage(data)) return;
      if (DEFERRED_HOST_TYPES.has(data.type)) {
        pendingRef.current.push(data);
        schedule();
        return;
      }
      // Control messages flush first so they never observe a half-applied stream.
      flush();
      apply(data);
    };

    window.addEventListener('message', onMessage);
    post({ type: 'ready' });
    return () => {
      window.removeEventListener('message', onMessage);
      cancelFrame();
    };
  }, []);

  /* composer prefill from host */
  useEffect(() => {
    const fill = state.composerFill;
    if (!fill) return;
    setDraft((previous) => ({
      text: fill.text,
      attachments: fill.attachments ?? previous.attachments,
    }));
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
    const mentions = extractMentions(text, chat?.files ?? []);
    const attachments = mergeMentionAttachments(draft.attachments ?? [], mentions);
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

  const restartBackend = (): void => {
    post({ type: 'restart-backend' });
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

  /* overlays close on Escape (approval first, then the session sheet) */
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
  const modelLabel = chat?.session.model?.label ?? 'No model';
  const permission = chat?.session.permission ?? 'read-only';
  const agentPresetId = chat?.session.agentPreset ?? null;
  const agentLabel =
    agentPresetId === null
      ? null
      : (chat?.agentPresets.find((preset) => preset.id === agentPresetId)?.name ?? agentPresetId);
  const efforts = chat?.session.model?.reasoningEfforts ?? [];
  const effortLabel =
    efforts.length === 0
      ? null
      : (chat?.session.reasoningEffort ??
        chat?.session.model?.defaultReasoningEffort ??
        'Default');
  const usage = selectUsage(state);
  const plan = useMemo(() => selectPlan(chat?.tools ?? {}), [chat?.tools]);
  const searchHits = selectSessionSearch(state);

  return (
    <div class="app">
      <Header
        chat={chat}
        sessionsOpen={sessionsOpen}
        onNewChat={newChat}
        onOpenSessions={openSessions}
        onSettings={() => post({ type: 'open-settings' })}
        onStartBackend={startBackend}
        onRestartBackend={restartBackend}
        onShowLogs={() => post({ type: 'show-logs' })}
      />

      <main class="chat-main">
        {chat === null ? (
          <div class="loading" role="status">
            <span class="working-dot" aria-hidden="true" />
            <span>Loading dsh-vscode-ok…</span>
          </div>
        ) : (
          <Transcript
            chat={chat}
            approval={approval}
            onOpenDiff={openDiff}
            onOpenFile={openFile}
            onCopy={copy}
            onApproval={answerApproval}
            onStartBackend={startBackend}
            onUseExample={useExample}
          />
        )}
      </main>

      {chat === null ? null : <PlanPanel plan={plan} running={running} />}

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

      <Composer
        draft={draft}
        backendStatus={backendStatus}
        running={running}
        modelLabel={modelLabel}
        permission={permission}
        agentLabel={agentLabel}
        effortLabel={effortLabel}
        usage={usage}
        commands={chat?.commands ?? []}
        files={chat?.files ?? []}
        skills={chat?.skills ?? []}
        textareaRef={textareaRef}
        onSend={send}
        onStop={stop}
        onChange={(text) => setDraft((previous) => ({ ...previous, text }))}
        onNewSession={newChat}
        onAttachFiles={() => post({ type: 'attach-files' })}
        onAttachSelection={() => post({ type: 'attach-selection' })}
        onAttachProblems={() => post({ type: 'attach-problems' })}
        onAddAttachment={(attachment) =>
          setDraft((previous) => ({
            ...previous,
            attachments: [...previous.attachments, attachment],
          }))
        }
        onRemoveAttachment={removeAttachment}
        onPickModel={() => post({ type: 'pick-model' })}
        onPickPermission={() => post({ type: 'pick-permission' })}
        onPickAgent={() => post({ type: 'pick-agent' })}
        onPickEffort={() => post({ type: 'pick-effort' })}
        onRequestFiles={(query) => post({ type: 'request-files', query })}
        onExecuteCommand={(name, line) => post({ type: 'execute-command', name, line })}
      />

      {sessionsOpen && chat !== null ? (
        <SessionPicker
          sessions={chat.sessions}
          activeId={chat.session.id}
          hits={searchHits}
          onSelect={pickSession}
          onClose={closeSessions}
          onSearch={(query) => post({ type: 'search-sessions', query })}
          onClearSearch={() => dispatch({ type: 'clear-search' })}
          onRename={(sessionId, title) => post({ type: 'rename-session', sessionId, title })}
          onFork={(sessionId) => post({ type: 'fork-session', sessionId })}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Mount                                                               */
/* ------------------------------------------------------------------ */

const root = document.getElementById('root');
if (root) render(<App />, root);
