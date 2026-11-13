/**
 * One transcript message: a right-aligned user bubble or an assistant message
 * with a small brand avatar, reasoning disclosure, markdown and tool rows.
 */

import type {
  ApprovalRequest,
  Attachment,
  ChatMessage,
  ReasoningPart,
  TextPart,
  ToolCall,
} from '../../shared/protocol';
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  ChevronIcon,
  CopyIcon,
  FileIcon,
  PulseIcon,
  SelectionIcon,
  SparkleIcon,
  TerminalIcon,
  WarningIcon,
} from '../icons';
import { renderMarkdown } from '../markdown';
import { basename, formatDuration } from '../util';
import { ToolCard } from './ToolCard';

export interface MessageViewProps {
  message: ChatMessage;
  tools: Record<string, ToolCall>;
  approvals: readonly ApprovalRequest[];
  onOpenDiff(toolId: string): void;
  onOpenFile(path: string, line?: number, endLine?: number): void;
  onCopy(text: string): void;
  onReviewApproval(): void;
}

let reasoningSequence = 0;

/* ------------------------------------------------------------------ */
/* Attachments                                                         */
/* ------------------------------------------------------------------ */

function attachmentIcon(kind: Attachment['kind']): JSX.Element {
  switch (kind) {
    case 'selection':
      return <SelectionIcon size={11} />;
    case 'diagnostics':
      return <PulseIcon size={11} />;
    case 'terminal':
      return <TerminalIcon size={11} />;
    default:
      return <FileIcon size={11} />;
  }
}

function attachmentLabel(attachment: Attachment): string {
  return attachment.label.trim() === '' ? basename(attachment.path ?? 'attachment') : attachment.label;
}

function AttachmentChip({ attachment }: { attachment: Attachment }): JSX.Element {
  const titleParts = [attachment.path ?? attachment.label];
  if (attachment.startLine !== undefined) {
    titleParts.push(
      attachment.endLine !== undefined && attachment.endLine !== attachment.startLine
        ? `lines ${attachment.startLine}-${attachment.endLine}`
        : `line ${attachment.startLine}`,
    );
  }
  return (
    <span class="attach-chip" title={titleParts.join(' · ')}>
      <span class="attach-chip-icon" aria-hidden="true">
        {attachmentIcon(attachment.kind)}
      </span>
      <span class="attach-chip-label">{attachmentLabel(attachment)}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Reasoning                                                           */
/* ------------------------------------------------------------------ */

function ReasoningView({ part, streaming }: { part: ReasoningPart; streaming: boolean }): JSX.Element {
  const [bodyId] = useState(() => `reasoning-${(reasoningSequence += 1)}`);
  const [open, setOpen] = useState(part.collapsed !== true);
  const wasStreaming = useRef(streaming);
  const startRef = useRef(Date.now());
  const [finishedAt, setFinishedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (streaming) {
      wasStreaming.current = true;
      setFinishedAt(null);
      setNow(Date.now());
      const timer = window.setInterval(() => setNow(Date.now()), 500);
      return () => window.clearInterval(timer);
    }
    if (wasStreaming.current) setFinishedAt((value) => value ?? Date.now());
    return undefined;
  }, [streaming]);

  /* Collapse once the assistant message is no longer streaming, unless the user
   * had already opened it manually: then the expansion was their choice. */
  useEffect(() => {
    if (!streaming && wasStreaming.current) setOpen(false);
  }, [streaming]);

  const elapsed = (finishedAt ?? now) - startRef.current;
  const label = streaming
    ? 'Thinking…'
    : wasStreaming.current
      ? `Thought for ${formatDuration(elapsed)}`
      : 'Thought process';

  return (
    <div class={`reasoning${streaming ? ' is-thinking' : ''}`}>
      <button
        type="button"
        class="reasoning-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
        title={open ? 'Hide reasoning' : 'Show reasoning'}
      >
        <span class="reasoning-label">{label}</span>
        <ChevronIcon size={11} class={open ? 'chev chev-open' : 'chev chev-closed'} />
      </button>
      {open ? (
        <div id={bodyId} class="reasoning-text">
          {part.text}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Notices                                                             */
/* ------------------------------------------------------------------ */

function NoticeView({
  level,
  text,
}: {
  level: 'info' | 'warning' | 'error';
  text: string;
}): JSX.Element {
  const icon = level === 'info' ? <SparkleIcon size={12} /> : <WarningIcon size={12} />;
  return (
    <div class={`notice notice-${level}`} role={level === 'info' ? 'status' : 'alert'}>
      <span class="notice-icon" aria-hidden="true">
        {icon}
      </span>
      <span class="notice-text">{text}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Message                                                             */
/* ------------------------------------------------------------------ */

function messageText(message: ChatMessage): string {
  return message.parts
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n')
    .trim();
}

export function MessageView({
  message,
  tools,
  approvals,
  onOpenDiff,
  onOpenFile,
  onCopy,
  onReviewApproval,
}: MessageViewProps): JSX.Element {
  const streaming = message.status === 'streaming';
  const hasText = message.parts.some((part) => part.type === 'text' && part.text.trim() !== '');

  const handleMarkdownClick = (event: JSX.TargetedMouseEvent<HTMLDivElement>): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>('button.code-copy');
    if (!button) return;
    const code = button.closest('.code-block')?.querySelector('code');
    const text = code?.textContent ?? '';
    if (text === '') return;
    onCopy(text);
    button.classList.add('is-copied');
    button.setAttribute('title', 'Copied');
    window.setTimeout(() => {
      button.classList.remove('is-copied');
      button.setAttribute('title', 'Copy code');
    }, 1500);
  };

  if (message.role === 'user') {
    return (
      <article class={`msg msg-user${message.status === 'error' ? ' is-error' : ''}`}>
        <div class="bubble">
          {message.parts.map((part, index) =>
            part.type === 'text' ? (
              <div key={index} class="msg-text">
                {part.text}
              </div>
            ) : null,
          )}
          {message.attachments && message.attachments.length > 0 ? (
            <div class="attachments">
              {message.attachments.map((attachment, index) => (
                <AttachmentChip key={`${attachment.label}-${index}`} attachment={attachment} />
              ))}
            </div>
          ) : null}
        </div>
      </article>
    );
  }

  const copyText = messageText(message);
  const meta = message.status === 'aborted' ? 'Stopped' : message.status === 'error' ? 'Failed' : null;

  return (
    <article class={`msg msg-assistant${streaming ? ' is-streaming' : ''}`}>
      <div class="avatar" aria-hidden="true">
        <SparkleIcon size={11} />
      </div>
      <div class="msg-content">
        <div class="msg-head">
          <span class="msg-role">dsh-vscode-ok</span>
          {meta ? <span class="msg-meta">{meta}</span> : null}
          {copyText !== '' ? (
            <button
              type="button"
              class="icon-btn icon-btn-small msg-copy"
              title="Copy message"
              aria-label="Copy message"
              onClick={() => onCopy(copyText)}
            >
              <CopyIcon size={12} />
            </button>
          ) : null}
        </div>

        <div class="msg-body">
          {message.parts.map((part, index) => {
            switch (part.type) {
              case 'text':
                return (
                  <div
                    key={index}
                    class="markdown"
                    onClick={handleMarkdownClick}
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(part.text) }}
                  />
                );
              case 'reasoning':
                return <ReasoningView key={index} part={part} streaming={streaming} />;
              case 'notice':
                return <NoticeView key={index} level={part.level} text={part.text} />;
              case 'tool': {
                const tool = tools[part.toolId];
                if (!tool) {
                  return (
                    <div key={index} class="tool-placeholder">
                      Preparing tool call…
                    </div>
                  );
                }
                const approval =
                  approvals.find(
                    (request) =>
                      (tool.approvalId !== undefined && request.id === tool.approvalId) ||
                      (request.toolCallId !== undefined && request.toolCallId === tool.id),
                  ) ?? null;
                return (
                  <ToolCard
                    key={index}
                    tool={tool}
                    approval={approval}
                    onOpenDiff={onOpenDiff}
                    onOpenFile={onOpenFile}
                    onReviewApproval={onReviewApproval}
                  />
                );
              }
              default:
                return null;
            }
          })}

          {message.status === 'error' && message.error ? (
            <div class="msg-error" role="alert">
              <WarningIcon size={12} />
              <span>{message.error}</span>
            </div>
          ) : null}

          {streaming ? (
            <div class="msg-working" role="status" aria-label="Assistant is working">
              <span class="working-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              {hasText ? null : <span class="sr-only">Assistant is working</span>}
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}
