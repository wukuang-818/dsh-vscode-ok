/**
 * Overlay session list: switch between sessions, running ones are badged.
 */

import type { SessionSummary } from '../../shared/protocol';
import type { JSX } from 'preact';
import { CrossIcon, SessionsIcon } from '../icons';

export interface SessionPickerProps {
  sessions: SessionSummary[];
  activeId: string | null;
  onPick(sessionId: string): void;
  onClose(): void;
}

function relativeTime(updatedAt: number | undefined): string {
  if (updatedAt === undefined) return '';
  const delta = Date.now() - updatedAt;
  if (!Number.isFinite(delta) || delta < 0) return '';
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(updatedAt).toLocaleDateString();
}

export function SessionPicker({ sessions, activeId, onPick, onClose }: SessionPickerProps): JSX.Element {
  return (
    <div class="overlay picker-overlay" onClick={onClose}>
      <div
        class="modal picker"
        role="dialog"
        aria-modal="true"
        aria-label="Sessions"
        onClick={(event) => event.stopPropagation()}
      >
        <div class="picker-head">
          <SessionsIcon size={14} />
          <h2 class="picker-title">Sessions</h2>
          <span class="spacer" />
          <button type="button" class="icon-btn" title="Close" aria-label="Close sessions" onClick={onClose}>
            <CrossIcon size={14} />
          </button>
        </div>
        {sessions.length === 0 ? (
          <p class="picker-empty">No sessions yet. Start a chat to create one.</p>
        ) : (
          <div class="picker-list">
            {sessions.map((session) => {
              const active = session.id === activeId;
              return (
                <button
                  type="button"
                  key={session.id}
                  class={`picker-item${active ? ' is-active' : ''}`}
                  title={session.title}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => onPick(session.id)}
                >
                  <span class="picker-item-title">{session.title}</span>
                  {session.running === true && <span class="running-badge">running</span>}
                  <span class="spacer" />
                  <span class="picker-time">{relativeTime(session.updatedAt)}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
