/**
 * Chat composer: auto-resizing textarea, attachment chips, attach actions and
 * the send / stop button. Enter sends, Shift+Enter inserts a newline.
 */

import type { BackendStatus } from '../../shared/protocol';
import type { Draft } from '../state';
import type { JSX } from 'preact';
import type { RefObject } from 'preact';
import { useEffect } from 'preact/hooks';
import {
  CrossIcon,
  FileIcon,
  SelectionIcon,
  SendIcon,
  StopIcon,
  WarningIcon,
} from '../icons';

export interface ComposerProps {
  draft: Draft;
  backendStatus: BackendStatus;
  running: boolean;
  textareaRef: RefObject<HTMLTextAreaElement>;
  onTextChange(text: string): void;
  onSend(): void;
  onStop(): void;
  onAttachFiles(): void;
  onAttachSelection(): void;
  onAttachProblems(): void;
  onRemoveAttachment(index: number): void;
}

function placeholderFor(status: BackendStatus): string {
  switch (status) {
    case 'starting':
      return 'Starting DSH backend…';
    case 'stopped':
      return 'Start the DSH backend to chat';
    case 'error':
      return 'DSH backend failed to start';
    case 'ready':
    default:
      return 'Ask DSH… (Enter to send, Shift+Enter for a newline)';
  }
}

export function Composer({
  draft,
  backendStatus,
  running,
  textareaRef,
  onTextChange,
  onSend,
  onStop,
  onAttachFiles,
  onAttachSelection,
  onAttachProblems,
  onRemoveAttachment,
}: ComposerProps): JSX.Element {
  const ready = backendStatus === 'ready';
  const attachments = draft.attachments ?? [];
  const canSend = ready && !running && (draft.text.trim() !== '' || attachments.length > 0);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [draft.text, textareaRef]);

  const handleKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (canSend) onSend();
  };

  return (
    <div class="composer">
      {attachments.length > 0 && (
        <div class="composer-attachments" aria-label="Attachments">
          {attachments.map((attachment, index) => (
            <span class="attach-chip composer-chip" key={`${attachment.label}-${index}`}>
              {attachment.kind === 'selection' ? (
                <SelectionIcon size={12} />
              ) : attachment.kind === 'diagnostics' ? (
                <WarningIcon size={12} />
              ) : (
                <FileIcon size={12} />
              )}
              <span class="attach-label">{attachment.label}</span>
              <button
                type="button"
                class="chip-remove"
                aria-label={`Remove ${attachment.label}`}
                title={`Remove ${attachment.label}`}
                onClick={() => onRemoveAttachment(index)}
              >
                <CrossIcon size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div class="composer-box">
        <textarea
          ref={textareaRef}
          class="composer-input"
          rows={1}
          value={draft.text}
          placeholder={placeholderFor(backendStatus)}
          disabled={!ready}
          aria-label="Message DSH"
          onInput={(event) => onTextChange(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
        />
        <div class="composer-actions">
          <button
            type="button"
            class="icon-btn"
            title="Attach file"
            aria-label="Attach file"
            onClick={onAttachFiles}
          >
            <FileIcon size={14} />
          </button>
          <button
            type="button"
            class="icon-btn"
            title="Attach selection"
            aria-label="Attach selection"
            onClick={onAttachSelection}
          >
            <SelectionIcon size={14} />
          </button>
          <button
            type="button"
            class="icon-btn"
            title="Attach problems"
            aria-label="Attach problems"
            onClick={onAttachProblems}
          >
            <WarningIcon size={14} />
          </button>
          <span class="spacer" />
          {running ? (
            <button type="button" class="btn btn-secondary stop-btn" title="Stop" aria-label="Stop" onClick={onStop}>
              <StopIcon size={12} />
              <span>Stop</span>
            </button>
          ) : (
            <button
              type="button"
              class="btn btn-primary send-btn"
              title="Send"
              aria-label="Send message"
              disabled={!canSend}
              onClick={onSend}
            >
              <SendIcon size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
