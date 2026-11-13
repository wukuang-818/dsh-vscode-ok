/**
 * Sessions dropdown: filter, full-text matches, rename and fork actions.
 *
 * The sheet is anchored under the header trigger. Filtering is client-side and
 * immediate; a 250 ms debounce asks the host for full-text search hits once the
 * query is long enough to be useful.
 */

import type { SessionSearchHit, SessionSummary } from '../../shared/protocol';
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { CheckIcon, ForkIcon, PencilIcon, SearchIcon } from '../icons';
import { basename } from '../util';

export interface SessionPickerProps {
  sessions: SessionSummary[];
  activeId: string | null;
  hits: readonly SessionSearchHit[];
  onSelect(id: string): void;
  onClose(): void;
  onSearch(query: string): void;
  onClearSearch(): void;
  onRename(sessionId: string, title: string): void;
  onFork(sessionId: string): void;
}

/** Query length that makes a host round-trip worth it. */
const SEARCH_MIN_LENGTH = 2;
const SEARCH_DEBOUNCE_MS = 250;

function formatUpdated(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (!Number.isFinite(diff) || diff < 60_000) return 'just now';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function SessionPicker({
  sessions,
  activeId,
  hits,
  onSelect,
  onClose,
  onSearch,
  onClearSearch,
  onRename,
  onFork,
}: SessionPickerProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const renameRef = useRef<HTMLInputElement | null>(null);

  // Keep the latest host callbacks without making them effect dependencies: the
  // parent recreates them on every render, which would retrigger the debounce.
  const searchHandler = useRef(onSearch);
  const clearHandler = useRef(onClearSearch);
  useEffect(() => {
    searchHandler.current = onSearch;
    clearHandler.current = onClearSearch;
  });

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    clearHandler.current();
    const needle = query.trim();
    if (needle.length < SEARCH_MIN_LENGTH) return;
    const timer = window.setTimeout(() => searchHandler.current(needle), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (editingId === null) return;
    const input = renameRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [editingId]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter((session) =>
      `${session.title} ${session.cwd ?? ''}`.toLowerCase().includes(needle),
    );
  }, [sessions, query]);

  const titleOf = (sessionId: string): string => {
    const found = sessions.find((session) => session.id === sessionId);
    return found?.title ?? 'Saved session';
  };

  const move = (direction: 1 | -1): void => {
    const options = listRef.current?.querySelectorAll<HTMLElement>('[role="option"]');
    if (!options || options.length === 0) return;
    const current = document.activeElement;
    let index = -1;
    options.forEach((option, optionIndex) => {
      if (option === current) index = optionIndex;
    });
    const next = index < 0 ? 0 : (index + direction + options.length) % options.length;
    options[next]?.focus();
  };

  const startRename = (session: SessionSummary): void => {
    setEditingId(session.id);
    setRenameValue(session.title || 'Untitled session');
  };

  const commitRename = (session: SessionSummary): void => {
    const title = renameValue.trim();
    setEditingId(null);
    if (title === '' || title === session.title) return;
    onRename(session.id, title);
  };

  return (
    <div class="picker-layer">
      <div class="picker-backdrop" onClick={onClose} />
      <section
        class="picker"
        role="dialog"
        aria-label="Sessions"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (editingId !== null) return;
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            move(1);
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            move(-1);
          }
        }}
      >
        <div class="picker-search">
          <SearchIcon size={13} />
          <input
            ref={searchRef}
            class="picker-filter"
            type="text"
            value={query}
            placeholder="Search sessions"
            aria-label="Search sessions"
            onInput={(event) => {
              setQuery(event.currentTarget.value);
              setEditingId(null);
            }}
          />
        </div>

        {hits.length > 0 ? (
          <div class="picker-matches">
            <p class="picker-section">Matches</p>
            {hits.map((hit) => (
              <button
                key={hit.sessionId}
                type="button"
                class="picker-hit"
                title={hit.snippet}
                onClick={() => onSelect(hit.sessionId)}
              >
                <span class="picker-hit-snippet">{hit.snippet}</span>
                <span class="picker-hit-meta">{titleOf(hit.sessionId)}</span>
              </button>
            ))}
          </div>
        ) : null}

        <div
          ref={listRef}
          class="picker-list"
          role="listbox"
          aria-label="Recent sessions"
        >
          {filtered.map((session) => {
            const active = session.id === activeId;
            const editing = editingId === session.id;
            return (
              <div
                key={session.id}
                class={`picker-item${active ? ' is-active' : ''}${editing ? ' is-editing' : ''}`}
                role="option"
                aria-selected={active}
                tabIndex={-1}
                title={session.cwd ?? session.title}
                onClick={() => {
                  if (!editing) onSelect(session.id);
                }}
                onDblClick={() => startRename(session)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !editing) {
                    event.preventDefault();
                    onSelect(session.id);
                  }
                }}
              >
                {editing ? (
                  <input
                    ref={renameRef}
                    class="picker-rename"
                    type="text"
                    value={renameValue}
                    aria-label={`Rename ${session.title || 'session'}`}
                    onClick={(event) => event.stopPropagation()}
                    onInput={(event) => setRenameValue(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        commitRename(session);
                      } else if (event.key === 'Escape') {
                        event.preventDefault();
                        setEditingId(null);
                      }
                    }}
                  />
                ) : (
                  <>
                    <span class="picker-item-main">
                      <span class="picker-item-title">
                        {session.title || 'Untitled session'}
                      </span>
                      <span class="picker-item-meta">
                        {session.cwd ? basename(session.cwd) : 'Workspace'}
                        {typeof session.updatedAt === 'number'
                          ? ` · ${formatUpdated(session.updatedAt)}`
                          : ''}
                      </span>
                    </span>
                    {session.running === true ? (
                      <span class="picker-running">Running</span>
                    ) : null}
                    {active ? (
                      <span class="picker-check" aria-hidden="true">
                        <CheckIcon size={13} />
                      </span>
                    ) : null}
                    <span class="picker-actions">
                      <button
                        type="button"
                        class="picker-action"
                        title="Rename session"
                        aria-label={`Rename ${session.title || 'session'}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          startRename(session);
                        }}
                      >
                        <PencilIcon size={12} />
                      </button>
                      <button
                        type="button"
                        class="picker-action"
                        title="Fork session"
                        aria-label={`Fork ${session.title || 'session'}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onFork(session.id);
                        }}
                      >
                        <ForkIcon size={12} />
                      </button>
                    </span>
                  </>
                )}
              </div>
            );
          })}

          {filtered.length === 0 ? (
            <p class="picker-empty">
              {sessions.length === 0 ? 'No sessions yet.' : `No sessions match “${query}”.`}
            </p>
          ) : null}
        </div>

        <p class="picker-hint">Esc to close</p>
      </section>
    </div>
  );
}
