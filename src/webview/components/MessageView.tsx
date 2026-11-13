/**
 * One chat message: right-aligned user bubble with attachment chips, full-width
 * assistant message with sanitized markdown, collapsible reasoning, tool cards,
 * inline notices and the streaming / error / aborted indicators.
 */

import type {
  ApprovalRequest,
  Attachment,
  ChatMessage,
  ChatPart,
  ToolCall,
} from '../../shared/protocol';
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import {
  ChevronIcon,
  CopyIcon,
  CrossIcon,
  FileIcon,
  SelectionIcon,
  TerminalIcon,
  WarningIcon,
} from '../icons';
import { renderMarkdown } from '../markdown';
import { ToolCard } from './ToolCard';

export interface MessageViewProps {
  message: ChatMessage;
  tools: Record<string, ToolCall>;
  approval: ApprovalRequest | null;
  onOpenDiff(toolId: string): void;
  onOpenFile(path: string, line?: number, endLine?: number): void;
  onCopy(text: string): void;
  onApproval(id: string, optionId: string): void;
}

function attachmentIcon(kind: Attachment['kind']): JSX.Element {
  switch (kind) {
    case 'selection':
      return <SelectionIcon size={12} />;
    case 'diagnostics':
      return <WarningIcon size={12} />;
    case 'terminal':
      return <TerminalIcon size={12} />;
    case 'file':
    case 'image':
    default:
      return <FileIcon size={12} />;
  }
}

function AttachmentChips({
  attachments,
  onOpenFile,
}: {
  attachments: Attachment[];
  onOpenFile(path: string, line?: number, endLine?: number): void;
}): JSX.Element {
  return (
    <div class="attachments">
      {attachments.map((attachment, index) => {
        const label =
          attachment.startLine !== undefined
            ? `${attachment.label}:${attachment.startLine}${attachment.endLine !== undefined ? `-${attachment.endLine}` : ''}`
            : attachment.label;
        const content = (
          <>
            {attachmentIcon(attachment.kind)}
            <span class="attach-label">{label}</span>
          </>
        );
        const path = attachment.path;
        return path !== undefined ? (
          <button
            type="button"
            key={`${path}-${index}`}
            class="attach-chip attach-chip-action"
            title={path}
            onClick={() => onOpenFile(path, attachment.startLine, attachment.endLine)}
          >
            {content}
          </button>
        ) : (
          <span class="attach-chip" key={`${label}-${index}`}>
            {content}
          </span>
        );
      })}
    </div>
  );
}

function ReasoningPartView({ text, collapsed }: { text: string; collapsed?: boolean }): JSX.Element {
  const [open, setOpen] = useState(collapsed === false);
  return (
    <div class={`reasoning${open ? ' open' : ''}`}>
      <button
        type="button"
        class="reasoning-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronIcon size={12} class={`chev${open ? ' chev-open' : ''}`} />
        <span class="reasoning-label">Reasoning</span>
        <span class="reasoning-meta">{text.length.toLocaleString()} chars</span>
      </button>
      {open && <div class="reasoning-text">{text}</div>}
    </div>
  );
}

function partsText(message: ChatMessage): string {
  const chunks: string[] = [];
  for (const part of message.parts) {
    if (part.type === 'text' && part.text !== '') chunks.push(part.text);
  }
  return chunks.join('\n\n').trim();
}

function hasTextPart(message: ChatMessage): boolean {
  return message.parts.some((part) => part.type === 'text' && part.text !== '');
}

function renderPart(part: ChatPart, index: number, props: MessageViewProps): JSX.Element | null {
  switch (part.type) {
    case 'text':
      if (part.text === '') return null;
      return (
        <div
          key={`text-${index}`}
          class="markdown"
          // Sanitized by DOMPurify in ../markdown; only allowed tags/URIs survive.
          dangerouslySetInnerHTML={{ __html: renderMarkdown(part.text) }}
        />
      );
    case 'reasoning':
      return <ReasoningPartView key={`reasoning-${index}`} text={part.text} collapsed={part.collapsed} />;
    case 'tool':
      return (
        <ToolCard
          key={`tool-${index}`}
          tool={props.tools[part.toolId]}
          approval={props.approval}
          onOpenDiff={props.onOpenDiff}
          onApproval={props.onApproval}
        />
      );
    case 'notice':
      return (
        <div key={`notice-${index}`} class={`notice notice-${part.level}`} role="status">
          {part.level === 'info' ? null : <WarningIcon size={12} />}
          <span>{part.text}</span>
        </div>
      );
    default:
      return null;
  }
}

function UserMessage({ message, onOpenFile }: { message: ChatMessage; onOpenFile: MessageViewProps['onOpenFile'] }): JSX.Element {
  return (
    <article class="msg msg-user" data-status={message.status}>
      <div class="bubble">
        {message.parts.map((part, index) =>
          part.type === 'text' && part.text !== '' ? (
            <div class="msg-text" key={`text-${index}`}>
              {part.text}
            </div>
          ) : null,
        )}
        {message.attachments && message.attachments.length > 0 && (
          <AttachmentChips attachments={message.attachments} onOpenFile={onOpenFile} />
        )}
      </div>
      {message.status === 'error' && message.error && (
        <div class="msg-error">
          <CrossIcon size={12} />
          <span>{message.error}</span>
        </div>
      )}
    </article>
  );
}

export function MessageView(props: MessageViewProps): JSX.Element {
  const { message, onCopy } = props;

  if (message.role === 'user') {
    return <UserMessage message={message} onOpenFile={props.onOpenFile} />;
  }

  const streaming = message.status === 'streaming';
  const copyable = partsText(message);
  const roleLabel = message.role === 'system' ? 'System' : 'dsh-vscode-ok';

  return (
    <article class={`msg msg-assistant${streaming ? ' is-streaming' : ''}`} data-status={message.status}>
      <div class="msg-head">
        <span class="msg-role">{roleLabel}</span>
        {message.status === 'aborted' && <span class="msg-meta">stopped</span>}
        {message.status === 'error' && <span class="msg-meta msg-meta-error">error</span>}
        <span class="spacer" />
        {copyable !== '' && (
          <button
            type="button"
            class="icon-btn icon-btn-small copy-btn"
            title="Copy message"
            aria-label="Copy message"
            onClick={() => onCopy(copyable)}
          >
            <CopyIcon size={12} />
          </button>
        )}
      </div>
      <div class="msg-body">
        {message.parts.map((part, index) => renderPart(part, index, props))}
      </div>
      {streaming && !hasTextPart(message) && (
        <div class="msg-working" role="status">
          <span class="working-dot" aria-hidden="true" />
          Working…
        </div>
      )}
      {message.status === 'error' && message.error && (
        <div class="msg-error">
          <WarningIcon size={12} />
          <span>{message.error}</span>
        </div>
      )}
    </article>
  );
}
