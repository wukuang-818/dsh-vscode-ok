/**
 * Transcript scroller: messages, the inline approval card, an empty-state
 * welcome block, and an auto-scroll that yields to the reader.
 */

import type { ApprovalRequest, ChatState, ToolCall } from '../../shared/protocol';
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ChevronIcon } from '../icons';
import { ApprovalDialog } from './ApprovalDialog';
import { EmptyState } from './EmptyState';
import { MessageView } from './MessageView';
import { ToolCard } from './ToolCard';

export interface TranscriptProps {
  chat: ChatState;
  approval: ApprovalRequest | null;
  onOpenDiff(toolId: string): void;
  onOpenFile(path: string, line?: number, endLine?: number): void;
  onCopy(text: string): void;
  onApproval(approvalId: string, optionId: string): void;
  onStartBackend(): void;
  onUseExample(text: string): void;
}

const BOTTOM_THRESHOLD = 28;

/** Messages rendered by default; older ones stay behind a "show earlier" step. */
const DEFAULT_WINDOW = 120;
const WINDOW_STEP = 200;

export function Transcript({
  chat,
  approval,
  onOpenDiff,
  onOpenFile,
  onCopy,
  onApproval,
  onStartBackend,
  onUseExample,
}: TranscriptProps): JSX.Element {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const lastUserIdRef = useRef<string | null>(null);
  const [detached, setDetached] = useState(false);
  const [windowSize, setWindowSize] = useState(DEFAULT_WINDOW);
  const restoreHeightRef = useRef<number | null>(null);

  const empty = chat.messages.length === 0;
  const firstVisible = Math.max(0, chat.messages.length - windowSize);
  const visibleMessages = firstVisible > 0 ? chat.messages.slice(firstVisible) : chat.messages;

  const isAtBottom = (element: HTMLElement): boolean =>
    element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_THRESHOLD;

  const scrollToLatest = (smooth: boolean): void => {
    const element = scrollerRef.current;
    if (!element) return;
    stickRef.current = true;
    setDetached(false);
    element.scrollTo({ top: element.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };

  const handleScroll = (): void => {
    const element = scrollerRef.current;
    if (!element) return;
    const atBottom = isAtBottom(element);
    stickRef.current = atBottom;
    setDetached(!atBottom);
  };

  useEffect(() => {
    const element = scrollerRef.current;
    if (!element) return;

    const last = chat.messages[chat.messages.length - 1];
    if (last && last.role === 'user' && last.id !== lastUserIdRef.current) {
      lastUserIdRef.current = last.id;
      stickRef.current = true;
      setDetached(false);
    }
    if (stickRef.current) element.scrollTop = element.scrollHeight;
  }, [chat.messages, chat.tools, approval]);

  // Keep the newest content visible when the viewport or the content itself
  // resizes, e.g. a toast appearing or a tool card expanding.
  useEffect(() => {
    const element = scrollerRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (stickRef.current) element.scrollTop = element.scrollHeight;
    });
    const observe = (): void => {
      observer.disconnect();
      observer.observe(element);
      for (const child of Array.from(element.children)) observer.observe(child);
    };
    observe();
    const mutations =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(observe);
    mutations?.observe(element, { childList: true });
    return () => {
      observer.disconnect();
      mutations?.disconnect();
    };
  }, []);

  // Growing the window prepends content, so keep the reader on the same message
  // by shifting scrollTop with the height the prepend added.
  useEffect(() => {
    const element = scrollerRef.current;
    const previous = restoreHeightRef.current;
    if (!element || previous === null) return;
    restoreHeightRef.current = null;
    const added = element.scrollHeight - previous;
    if (added > 0) element.scrollTop += added;
  }, [windowSize]);

  const showEarlier = (): void => {
    const element = scrollerRef.current;
    if (element) restoreHeightRef.current = element.scrollHeight;
    setWindowSize((size) => size + WINDOW_STEP);
  };

  const focusApproval = (): void => {
    const card = scrollerRef.current?.querySelector<HTMLElement>('.approval-card');
    if (!card) return;
    card.scrollIntoView({ block: 'nearest' });
    card.querySelector<HTMLButtonElement>('.approval-primary')?.focus();
  };

  const referencedTools = new Set<string>();
  for (const message of chat.messages) {
    for (const part of message.parts) {
      if (part.type === 'tool') referencedTools.add(part.toolId);
    }
  }
  const orphanTools: ToolCall[] = Object.values(chat.tools)
    .filter((tool) => !referencedTools.has(tool.id))
    .sort((left, right) => left.startedAt - right.startedAt);

  const approvalFor = (tool: ToolCall): ApprovalRequest | null =>
    approval !== null &&
    ((tool.approvalId !== undefined && approval.id === tool.approvalId) ||
      (approval.toolCallId !== undefined && approval.toolCallId === tool.id))
      ? approval
      : null;

  return (
    <div class="transcript-wrap">
      <div
        ref={scrollerRef}
        class={`transcript${empty ? ' is-empty' : ''}`}
        onScroll={handleScroll}
      >
        {empty ? (
          <EmptyState
            backendStatus={chat.backend.status}
            backendDetail={chat.backend.detail}
            onStart={onStartBackend}
            onUseExample={onUseExample}
          />
        ) : (
          <>
            {firstVisible > 0 ? (
              <button type="button" class="transcript-earlier" onClick={showEarlier}>
                Show earlier messages ({firstVisible})
              </button>
            ) : null}
            {visibleMessages.map((message) => (
              <MessageView
                key={message.id}
                message={message}
                tools={chat.tools}
                approvals={approval === null ? [] : [approval]}
                onOpenDiff={onOpenDiff}
                onOpenFile={onOpenFile}
                onCopy={onCopy}
                onReviewApproval={focusApproval}
              />
            ))}
          </>
        )}

        {orphanTools.length > 0 ? (
          <div class="transcript-orphans">
            {orphanTools.map((tool) => (
              <ToolCard
                key={tool.id}
                tool={tool}
                approval={approvalFor(tool)}
                onOpenDiff={onOpenDiff}
                onOpenFile={onOpenFile}
                onReviewApproval={focusApproval}
              />
            ))}
          </div>
        ) : null}

        {approval !== null ? (
          <ApprovalDialog
            request={approval}
            onAnswer={(optionId) => onApproval(approval.id, optionId)}
          />
        ) : null}
      </div>

      {detached ? (
        <button
          type="button"
          class="scroll-bottom"
          title="Scroll to latest"
          aria-label="Scroll to latest"
          onClick={() => scrollToLatest(true)}
        >
          <ChevronIcon size={14} />
        </button>
      ) : null}
    </div>
  );
}
