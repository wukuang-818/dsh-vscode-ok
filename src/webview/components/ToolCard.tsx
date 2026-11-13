/**
 * Inline tool-call card: status icon, title, collapsible input/output, diff
 * summary that opens the diff view, and inline approve/reject buttons while the
 * host waits for approval.
 */

import type { ApprovalRequest, ToolCall } from '../../shared/protocol';
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import {
  CheckIcon,
  ChevronIcon,
  CrossIcon,
  RefreshIcon,
  SparkleIcon,
  WarningIcon,
} from '../icons';
import { selectApprovalChoices } from '../state';

export interface ToolCardProps {
  tool: ToolCall | undefined;
  approval: ApprovalRequest | null;
  onOpenDiff(toolId: string): void;
  onApproval(id: string, optionId: string): void;
}

interface StatusMeta {
  label: string;
  tone: string;
  icon: JSX.Element;
}

function statusMeta(tool: ToolCall): StatusMeta {
  switch (tool.status) {
    case 'pending':
      return { label: 'Pending', tone: 'muted', icon: <SparkleIcon size={12} /> };
    case 'awaiting-approval':
      return { label: 'Awaiting approval', tone: 'warning', icon: <WarningIcon size={12} /> };
    case 'running':
      return { label: 'Running', tone: 'running', icon: <RefreshIcon size={12} class="spin" /> };
    case 'done':
      return { label: 'Done', tone: 'success', icon: <CheckIcon size={12} /> };
    case 'error':
      return { label: 'Failed', tone: 'error', icon: <CrossIcon size={12} /> };
    case 'canceled':
    default:
      return { label: 'Canceled', tone: 'muted', icon: <CrossIcon size={12} /> };
  }
}

function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toolTitle(tool: ToolCall): string {
  if (tool.title !== '') return tool.title;
  if (tool.name !== '') return tool.name;
  return 'Tool call';
}

function matchingApproval(tool: ToolCall, approval: ApprovalRequest | null): ApprovalRequest | null {
  if (!approval) return null;
  if (approval.toolCallId !== undefined && approval.toolCallId === tool.id) return approval;
  if (tool.approvalId !== undefined && approval.id === tool.approvalId) return approval;
  return null;
}

export function ToolCard({ tool, approval, onOpenDiff, onApproval }: ToolCardProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);

  if (!tool) {
    return (
      <div class="tool-card tool-placeholder">
        <SparkleIcon size={12} class="spin" />
        <span>Preparing tool call…</span>
      </div>
    );
  }

  const meta = statusMeta(tool);
  const input = stringifyValue(tool.input);
  const output = stringifyValue(tool.output);
  const hasIO = input !== '' || output !== '';
  const request = matchingApproval(tool, approval);
  const choices = request ? selectApprovalChoices(request) : null;
  const rejectChoice = choices ? choices.reject : null;

  return (
    <div class={`tool-card tool-${tool.status}`} data-status={tool.status}>
      <div class="tool-head">
        <button
          type="button"
          class="tool-toggle"
          aria-expanded={expanded}
          title={hasIO ? 'Show input and output' : 'No input or output recorded'}
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronIcon size={12} class={`chev${expanded ? ' chev-open' : ''}`} />
          <span class={`tool-status tool-status-${meta.tone}`} title={meta.label} aria-label={meta.label}>
            {meta.icon}
          </span>
          <span class="tool-title">{toolTitle(tool)}</span>
          {tool.childSessionId !== undefined && <span class="tool-badge">sub-agent</span>}
        </button>
        {tool.diff && (
          <button
            type="button"
            class="diff-chip"
            title={`Open diff for ${tool.diff.path}`}
            aria-label={`Open diff for ${tool.diff.path}`}
            onClick={() => onOpenDiff(tool.id)}
          >
            <span class="diff-path">{basename(tool.diff.path)}</span>
            <span class="diff-add">+{tool.diff.added}</span>
            <span class="diff-del">-{tool.diff.removed}</span>
          </button>
        )}
      </div>
      {request && choices && (
        <div class="tool-approval" role="group" aria-label="Approval required">
          <div class="tool-approval-text">
            <WarningIcon size={12} />
            <span>{request.title}</span>
          </div>
          <div class="tool-approval-actions">
            <button
              type="button"
              class={`btn ${choices.approve.danger ? 'btn-danger' : 'btn-primary'}`}
              onClick={() => onApproval(request.id, choices.approve.id)}
            >
              {choices.approve.label}
            </button>
            {rejectChoice && (
              <button
                type="button"
                class="btn btn-secondary"
                onClick={() => onApproval(request.id, rejectChoice.id)}
              >
                {rejectChoice.label}
              </button>
            )}
          </div>
        </div>
      )}
      {expanded && (
        <div class="tool-body">
          {input !== '' && (
            <div class="tool-io">
              <div class="tool-io-label">Input</div>
              <pre class="tool-io-pre">{input}</pre>
            </div>
          )}
          {output !== '' && (
            <div class="tool-io">
              <div class="tool-io-label">Output</div>
              <pre class="tool-io-pre">{output}</pre>
            </div>
          )}
          {!hasIO && <div class="tool-empty">No input or output recorded.</div>}
        </div>
      )}
    </div>
  );
}
