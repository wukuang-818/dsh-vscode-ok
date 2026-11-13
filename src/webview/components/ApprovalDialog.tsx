/**
 * Modal approval prompt. Rendered whenever the host sends an approval request;
 * answering posts an `approval` message through the callback supplied by App.
 */

import type { ApprovalRequest } from '../../shared/protocol';
import type { JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { WarningIcon } from '../icons';

export interface ApprovalDialogProps {
  request: ApprovalRequest;
  onAnswer(optionId: string): void;
}

const TITLE_ID = 'approval-dialog-title';

export function ApprovalDialog({ request, onAnswer }: ApprovalDialogProps): JSX.Element {
  const firstOptionRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    firstOptionRef.current?.focus();
  }, []);

  const captureFirst = (element: HTMLButtonElement | null): void => {
    firstOptionRef.current = element;
  };

  return (
    <div class="overlay approval-overlay">
      <div class="modal approval-dialog" role="dialog" aria-modal="true" aria-labelledby={TITLE_ID}>
        <div class="approval-head">
          <WarningIcon size={14} />
          <h2 class="approval-title" id={TITLE_ID}>
            {request.title}
          </h2>
        </div>
        <div class="approval-tool">{request.toolName}</div>
        {request.detail !== undefined && request.detail !== '' && (
          <pre class="approval-detail">{request.detail}</pre>
        )}
        <div class="approval-options">
          {request.options.map((option, index) => (
            <button
              type="button"
              key={option.id}
              ref={index === 0 ? captureFirst : null}
              class={`approval-option${index === 0 ? ' is-default' : ''}${
                option.danger ? ' approval-option-danger' : ''
              }`}
              onClick={() => onAnswer(option.id)}
            >
              <span class="approval-option-label">{option.label}</span>
              {option.description !== undefined && option.description !== '' && (
                <span class="approval-option-desc">{option.description}</span>
              )}
            </button>
          ))}
        </div>
        <p class="approval-hint">Esc picks the dismissing option.</p>
      </div>
    </div>
  );
}
