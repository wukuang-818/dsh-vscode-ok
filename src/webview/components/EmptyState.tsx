/**
 * Welcome block shown when the chat has no messages yet.
 *
 * It lives inside the transcript scroller so the composer stays anchored at the
 * bottom and an approval card can still appear underneath the suggestions.
 */

import type { BackendStatus } from '../../shared/protocol';
import type { ComponentType, JSX } from 'preact';
import {
  BookIcon,
  BugIcon,
  FlaskIcon,
  PulseIcon,
  RefreshIcon,
  SelectionIcon,
  SparkleIcon,
  WarningIcon,
} from '../icons';
import type { IconProps } from '../icons';

export interface EmptyStateProps {
  backendStatus: BackendStatus;
  backendDetail?: string;
  onStart(): void;
  onUseExample(text: string): void;
}

interface Suggestion {
  label: string;
  icon: ComponentType<IconProps>;
}

const SUGGESTIONS: readonly Suggestion[] = [
  { label: 'Explain this codebase', icon: BookIcon },
  { label: 'Find a bug in the current file', icon: BugIcon },
  { label: 'Write tests for a file', icon: FlaskIcon },
  { label: 'Explain the current selection', icon: SelectionIcon },
  { label: 'Run diagnostics and fix them', icon: PulseIcon },
];

export function EmptyState({
  backendStatus,
  backendDetail,
  onStart,
  onUseExample,
}: EmptyStateProps): JSX.Element {
  const ready = backendStatus === 'ready';

  return (
    <div class="empty">
      <div class="empty-inner">
        <div class="empty-mark" aria-hidden="true">
          <SparkleIcon size={20} />
        </div>
        <h1 class="empty-title">How can I help?</h1>
        <p class="empty-sub">Ask about this workspace, or start with one of these.</p>

        {backendStatus === 'starting' ? (
          <p class="empty-note" role="status">
            Starting the backend…
          </p>
        ) : null}

        {backendStatus === 'stopped' ? (
          <div class="empty-note-block">
            <p class="empty-note">The backend is stopped.</p>
            <button type="button" class="btn btn-primary" onClick={onStart}>
              <RefreshIcon size={12} />
              Start backend
            </button>
          </div>
        ) : null}

        {backendStatus === 'error' ? (
          <div class="empty-error" role="alert">
            <WarningIcon size={13} class="empty-error-icon" />
            <div class="empty-error-body">
              <p class="empty-error-text">{backendDetail ?? 'The backend stopped unexpectedly.'}</p>
              <button type="button" class="btn btn-secondary" onClick={onStart}>
                <RefreshIcon size={12} />
                Restart backend
              </button>
            </div>
          </div>
        ) : null}

        <div class="empty-suggestions" aria-label="Suggested prompts">
          {SUGGESTIONS.map(({ label, icon: Icon }) => (
            <button
              key={label}
              type="button"
              class="suggestion"
              onClick={() => onUseExample(label)}
              disabled={!ready}
              title={ready ? label : 'Start the backend to send a message'}
            >
              <Icon size={14} class="suggestion-icon" />
              <span class="suggestion-label">{label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
