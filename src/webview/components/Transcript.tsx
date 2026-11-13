/**
 * Scrollable transcript. Keeps the view pinned to the newest content while
 * streaming unless the user scrolled away, in which case a jump-to-bottom pill
 * appears. Tool calls that never received a message part are rendered after the
 * messages so they stay visible.
 */

import type { ApprovalRequest, ChatState, ToolCall } from '../../shared/protocol';
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ChevronIcon } from '../icons';
import { MessageView } from './MessageView';
import { ToolCard } from './ToolCard';

export interface TranscriptProps {
  chat: ChatState;
  approval: ApprovalRequest | null;
  onOpenDiff(toolId: string): void;
  onOpenFile(path: string, line?: number, endLine?: number): void;
  onCopy(text: string): void;
  onApproval(id: string, optionId: string): void;
}

/** Distance from the bottom (px) that still counts as "stuck to bottom". */
const STICK_THRESHOLD = 48;

export function Transcript({
  chat,
  approval,
  onOpenDiff,
  onOpenFile,
  onCopy,
  onApproval,
}: TranscriptProps): JSX.Element {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [detached, setDetached] = useState(false);

  const scrollToBottom = (behavior: ScrollBehavior): void => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior });
  };

  // Runs after every render (cheap): while streaming, each delta re-renders.
  useEffect(() => {
    if (stickRef.current) scrollToBottom('auto');
  });

  const handleScroll = (): void => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    const stick = distance < STICK_THRESHOLD;
    stickRef.current = stick;
    if (detached === stick) setDetached(!stick);
  };

  const jumpToBottom = (): void => {
    stickRef.current = true;
    setDetached(false);
    scrollToBottom('smooth');
  };

  const referenced = new Set<string>();
  for (const message of chat.messages) {
    for (const part of message.parts) {
      if (part.type === 'tool') referenced.add(part.toolId);
    }
  }
  const orphans: ToolCall[] = Object.entries(chat.tools)
    .filter(([id]) => !referenced.has(id))
    .map(([, tool]) => tool);

  return (
    <div class="transcript-wrap">
      <div
        class="transcript"
        ref={scrollerRef}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        onScroll={handleScroll}
      >
        {chat.messages.map((message) => (
          <MessageView
            key={message.id}
            message={message}
            tools={chat.tools}
            approval={approval}
            onOpenDiff={onOpenDiff}
            onOpenFile={onOpenFile}
            onCopy={onCopy}
            onApproval={onApproval}
          />
        ))}
        {orphans.length > 0 && (
          <div class="transcript-orphans">
            {orphans.map((tool) => (
              <ToolCard
                key={tool.id}
                tool={tool}
                approval={approval}
                onOpenDiff={onOpenDiff}
                onApproval={onApproval}
              />
            ))}
          </div>
        )}
      </div>
      {detached && (
        <button type="button" class="jump-pill" onClick={jumpToBottom} aria-label="Jump to latest message">
          <ChevronIcon size={12} class="chev chev-up" />
          <span>Latest</span>
        </button>
      )}
    </div>
  );
}
