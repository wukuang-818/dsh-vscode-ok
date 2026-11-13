/**
 * Inline approval decision card.
 *
 * Replaces the old centered modal: the card sits at the end of the transcript,
 * keeps the conversation visible, and focuses its primary action so keyboard
 * users can decide immediately. Answers still travel through the existing
 * `approval` webview message.
 */

import type { ApprovalRequest } from '../../shared/protocol';
import type { JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { WarningIcon } from '../icons';

export interface ApprovalDialogProps {
  request: ApprovalRequest;
  onAnswer(optionId: string): void;
}

const REJECT_PATTERN = /reject|deny|decline|cancel|skip|dismiss|no\b/i;

function isRejectOption(id: string, label: string): boolean {
  return REJECT_PATTERN.test(`${id} ${label}`);
}

export function ApprovalDialog({ request, onAnswer }: ApprovalDialogProps): JSX.Element {
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);

  const primary = request.options[0] ?? null;
  const reject =
    [...request.options].reverse().find((option) => isRejectOption(option.id, option.label)) ?? null;
  const secondary =
    primary === null
      ? null
      : (request.options.find(
          (option) => option.id !== primary.id && option.id !== reject?.id,
        ) ?? null);
  const canSkip = reject !== null && primary !== null && reject.id !== primary.id;

  useEffect(() => {
    cardRef.current?.scrollIntoView({ block: 'nearest' });
    primaryRef.current?.focus({ preventScroll: true });
  }, [request.id]);

  return (
    <section
      ref={cardRef}
      class="approval-card"
      role="group"
      aria-labelledby="dsh-approval-title"
      aria-describedby={request.detail ? 'dsh-approval-detail' : undefined}
    >
      <div class="approval-leading" aria-hidden="true">
        <WarningIcon size={15} />
      </div>
      <div class="approval-content">
        <h2 id="dsh-approval-title" class="approval-title">
          Approval needed
        </h2>
        <p class="approval-subtitle">{request.title}</p>
        <p class="approval-tool">{request.toolName}</p>
        {request.detail ? (
          <pre id="dsh-approval-detail" class="approval-detail">
            {request.detail}
          </pre>
        ) : null}

        <div class="approval-actions">
          {primary ? (
            <button
              ref={primaryRef}
              type="button"
              class={`btn btn-primary approval-primary${primary.danger === true ? ' is-danger' : ''}`}
              title={primary.description ?? primary.label}
              onClick={() => onAnswer(primary.id)}
            >
              {primary.label}
            </button>
          ) : null}

          {secondary ? (
            <button
              type="button"
              class="btn btn-secondary"
              title={secondary.description ?? secondary.label}
              onClick={() => onAnswer(secondary.id)}
            >
              {secondary.label}
            </button>
          ) : null}

          {canSkip ? (
            <button
              type="button"
              class="btn btn-ghost"
              title={`${reject.label} (Esc)`}
              aria-label={`Skip: ${reject.label}`}
              onClick={() => onAnswer(reject.id)}
            >
              Skip
            </button>
          ) : null}
        </div>

        <p class="approval-hint">Esc to dismiss</p>
      </div>
    </section>
  );
}
