/**
 * Single-row chat header: brand mark, session picker trigger, and icon actions.
 *
 * Model, permission and agent selection live in the composer toolbar now, so the
 * header only carries session-level actions plus a compact backend state hint
 * that appears when the backend is not ready.
 */

import type { ChatState } from '../../shared/protocol';
import type { BackendStatus } from '../../shared/protocol';
import type { JSX } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { useDismiss } from '../hooks';
import {
  ChevronIcon,
  EllipsisIcon,
  HistoryIcon,
  PlusIcon,
  RefreshIcon,
  SettingsIcon,
  SparkleIcon,
  TerminalIcon,
} from '../icons';

export interface HeaderProps {
  chat: ChatState | null;
  sessionsOpen: boolean;
  onNewChat(): void;
  onOpenSessions(): void;
  onSettings(): void;
  onStartBackend(): void;
  onRestartBackend(): void;
  onShowLogs(): void;
}

const STATUS_LABELS: Record<BackendStatus, string> = {
  stopped: 'Stopped',
  starting: 'Starting',
  ready: 'Ready',
  error: 'Error',
};

export function Header({
  chat,
  sessionsOpen,
  onNewChat,
  onOpenSessions,
  onSettings,
  onStartBackend,
  onRestartBackend,
  onShowLogs,
}: HeaderProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useDismiss(menuOpen, menuRef, () => setMenuOpen(false));

  const backend = chat?.backend ?? null;
  const status: BackendStatus = backend?.status ?? 'starting';
  const sessionTitle = chat?.session.title ?? 'New chat';
  const workspace = chat?.workspace.name ?? '';
  const running = chat?.session.running ?? false;
  const statusLabel = STATUS_LABELS[status];
  const statusTitle = backend?.detail ? `${statusLabel}: ${backend.detail}` : statusLabel;

  const choose = (action: () => void) => (): void => {
    setMenuOpen(false);
    action();
  };

  return (
    <header class="header">
      <button
        type="button"
        class={`session-trigger${sessionsOpen ? ' is-open' : ''}`}
        onClick={onOpenSessions}
        aria-haspopup="dialog"
        aria-expanded={sessionsOpen}
        title={workspace ? `${sessionTitle} · ${workspace}` : sessionTitle}
      >
        <span class="brand-mark" aria-hidden="true">
          <SparkleIcon size={11} />
        </span>
        <span class="session-title">{sessionTitle}</span>
        {running ? <span class="running-dot" role="status" aria-label="Assistant is running" /> : null}
        <ChevronIcon size={12} class="chev header-chevron" />
      </button>

      {status === 'starting' ? (
        <span class="status-pill status-starting" role="status" title={statusTitle}>
          <span class="status-dot" aria-hidden="true" />
          <span class="status-text">{statusLabel}</span>
          <span class="sr-only">Backend starting</span>
        </span>
      ) : null}

      {status === 'stopped' || status === 'error' ? (
        <button
          type="button"
          class={`status-pill status-${status}`}
          onClick={status === 'error' ? onRestartBackend : onStartBackend}
          title={`${statusTitle} — click to ${status === 'error' ? 'restart' : 'start'}`}
          aria-label={`Backend ${statusLabel}. Click to ${status === 'error' ? 'restart' : 'start'}.`}
        >
          <span class="status-dot" aria-hidden="true" />
          <span class="status-text">{statusLabel}</span>
        </button>
      ) : null}

      <button type="button" class="icon-btn" title="New chat" aria-label="New chat" onClick={onNewChat}>
        <PlusIcon size={14} />
      </button>

      <button
        type="button"
        class={`icon-btn${sessionsOpen ? ' is-active' : ''}`}
        title="Chat sessions"
        aria-label="Chat sessions"
        aria-haspopup="dialog"
        aria-expanded={sessionsOpen}
        onClick={onOpenSessions}
      >
        <HistoryIcon size={14} />
      </button>

      <div class="menu-anchor" ref={menuRef}>
        <button
          type="button"
          class={`icon-btn${menuOpen ? ' is-active' : ''}`}
          title="More actions"
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <EllipsisIcon size={14} />
        </button>
        {menuOpen ? (
          <div class="menu header-menu" role="menu" aria-label="More actions">
            <button type="button" class="menu-item" role="menuitem" onClick={choose(onSettings)}>
              <SettingsIcon size={13} />
              <span>Settings</span>
            </button>
            <button
              type="button"
              class="menu-item"
              role="menuitem"
              onClick={choose(status === 'stopped' ? onStartBackend : onRestartBackend)}
            >
              <RefreshIcon size={13} />
              <span>{status === 'stopped' ? 'Start backend' : 'Restart backend'}</span>
            </button>
            <button type="button" class="menu-item" role="menuitem" onClick={choose(onShowLogs)}>
              <TerminalIcon size={13} />
              <span>Show logs</span>
            </button>
          </div>
        ) : null}
      </div>
    </header>
  );
}
