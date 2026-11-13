/**
 * Compact tool-call row in the Copilot style: status glyph, verb, target and a
 * details disclosure. Expanded details keep the raw input/output, the approval
 * description and the diff entry point that the previous card exposed.
 */

import type { ApprovalRequest, FileDiffSummary, ToolCall } from '../../shared/protocol';
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { CheckIcon, ChevronIcon, CrossIcon, RefreshIcon, WarningIcon } from '../icons';
import { formatDuration, parseJsonObject, pickString } from '../util';

export interface ToolCardProps {
  tool: ToolCall;
  approval: ApprovalRequest | null;
  onOpenDiff(toolId: string): void;
  onOpenFile(path: string, line?: number, endLine?: number): void;
  onReviewApproval(): void;
}

const VERB_RULES: ReadonlyArray<{ pattern: RegExp; verb: string }> = [
  { pattern: /web[-_ ]?search|search[-_ ]?web/, verb: 'Searching the web' },
  { pattern: /str[_ -]?replace|apply[_ -]?patch|\bedit\b|replace|patch/, verb: 'Editing' },
  { pattern: /write|create|save|append/, verb: 'Writing' },
  { pattern: /read|\bview\b|\bcat\b|open[_ -]?file/, verb: 'Reading' },
  { pattern: /list|glob|\bls\b|\bdir\b/, verb: 'Listing' },
  { pattern: /grep|search|find/, verb: 'Searching' },
  { pattern: /test/, verb: 'Running tests' },
  { pattern: /pwsh|powershell|shell|bash|zsh|terminal|exec|command|\brun\b/, verb: 'Running command' },
  { pattern: /delete|remove|unlink|\brm\b/, verb: 'Deleting' },
  { pattern: /agent|subagent|delegate|spawn/, verb: 'Running sub-agent' },
  { pattern: /todo|plan/, verb: 'Updating tasks' },
  { pattern: /diagnostic|problem/, verb: 'Checking diagnostics' },
  { pattern: /image|screenshot|photo/, verb: 'Viewing image' },
  { pattern: /move|rename|copy/, verb: 'Moving' },
  { pattern: /fetch|http|download/, verb: 'Fetching' },
];

const PATH_KEYS = ['path', 'filePath', 'file_path', 'filename', 'file', 'target', 'absolutePath'] as const;
const DETAIL_KEYS = ['command', 'cmd', 'script', 'query', 'pattern', 'url'] as const;

const STATUS_TEXT: Record<ToolCall['status'], string> = {
  pending: 'Queued',
  'awaiting-approval': 'Waiting for approval',
  running: 'Running',
  done: 'Completed',
  error: 'Failed',
  canceled: 'Canceled',
};

interface Description {
  verb: string;
  target: string;
  path: string | null;
}

function describeTool(tool: ToolCall): Description {
  const input = parseJsonObject(tool.input);
  const path = tool.diff?.path ?? pickString(input, PATH_KEYS) ?? null;
  const title = tool.title.trim();
  const lowerName = tool.name.toLowerCase();
  const lowerTitle = title.toLowerCase();

  let verb = VERB_RULES.find((rule) => rule.pattern.test(lowerName))?.verb ?? '';
  if (verb === '') {
    const fromTitle = [...VERB_RULES]
      .map((rule) => rule.verb)
      .sort((left, right) => right.length - left.length)
      .find((candidate) => lowerTitle.startsWith(`${candidate.toLowerCase()} `));
    if (fromTitle) verb = fromTitle;
  }

  let target = path ?? pickString(input, DETAIL_KEYS) ?? '';
  if (target === '' && verb !== '' && lowerTitle.startsWith(`${verb.toLowerCase()} `)) {
    target = title.slice(verb.length + 1).trim();
  }

  if (verb === '') {
    verb = title !== '' ? title : tool.name.replace(/[_-]+/g, ' ');
    target = path ?? '';
  }

  return { verb, target, path };
}

function statusTone(status: ToolCall['status']): string {
  switch (status) {
    case 'done':
      return 'success';
    case 'error':
      return 'error';
    case 'canceled':
      return 'muted';
    case 'awaiting-approval':
      return 'warning';
    default:
      return 'running';
  }
}

function StatusGlyph({ status }: { status: ToolCall['status'] }): JSX.Element {
  switch (status) {
    case 'done':
      return <CheckIcon size={13} />;
    case 'error':
      return <CrossIcon size={13} />;
    case 'canceled':
      return <CrossIcon size={12} />;
    case 'awaiting-approval':
      return <WarningIcon size={13} />;
    default:
      return <RefreshIcon size={13} class="spin" />;
  }
}

function DiffStat({ diff }: { diff: FileDiffSummary }): JSX.Element {
  return (
    <span class="diff-stat" aria-label={`${diff.added} lines added, ${diff.removed} lines removed`}>
      <span class="diff-add">+{diff.added}</span>
      <span class="diff-del">−{diff.removed}</span>
    </span>
  );
}

function formatInput(raw: string): string {
  const parsed = parseJsonObject(raw);
  return parsed ? JSON.stringify(parsed, null, 2) : raw;
}

export function ToolCard({
  tool,
  approval,
  onOpenDiff,
  onOpenFile,
  onReviewApproval,
}: ToolCardProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const { verb, target, path } = describeTool(tool);
  const tone = statusTone(tool.status);
  const statusText = STATUS_TEXT[tool.status];
  const toggle = (): void => setExpanded((value) => !value);

  const elapsed =
    tool.endedAt !== undefined && tool.endedAt >= tool.startedAt
      ? formatDuration(tool.endedAt - tool.startedAt)
      : null;

  const openTarget = (): void => {
    if (path !== null) onOpenFile(path);
  };

  return (
    <section class={`tool tool-${tone}`} aria-label={`${verb} ${target}`.trim()}>
      <div class="tool-row">
        <span class={`tool-status tool-status-${tone}`} title={statusText}>
          <StatusGlyph status={tool.status} />
          <span class="sr-only">{statusText}</span>
        </span>

        <button
          type="button"
          class="tool-toggle"
          aria-expanded={expanded}
          title={expanded ? 'Hide details' : 'Show details'}
          onClick={toggle}
        >
          <span class="tool-verb">{verb}</span>
        </button>

        {target === '' ? null : path !== null ? (
          <button type="button" class="tool-target" title={path} onClick={openTarget}>
            {target}
          </button>
        ) : (
          <span class="tool-target tool-target-text" title={target}>
            {target.split('\n')[0]}
          </span>
        )}

        <span class="tool-spacer" />

        {tool.childSessionId !== undefined ? <span class="tool-badge">sub-agent</span> : null}
        {tool.diff ? <DiffStat diff={tool.diff} /> : null}

        {approval !== null ? (
          <button
            type="button"
            class="review-btn"
            onClick={onReviewApproval}
            title="Review the approval request"
          >
            Review
          </button>
        ) : null}

        <button
          type="button"
          class="icon-btn icon-btn-small tool-chev"
          aria-expanded={expanded}
          aria-label={expanded ? 'Hide tool details' : 'Show tool details'}
          onClick={toggle}
        >
          <ChevronIcon size={11} class={expanded ? 'chev chev-open' : 'chev chev-closed'} />
        </button>
      </div>

      {expanded ? (
        <div class="tool-body">
          {approval !== null ? (
            <div class="tool-approval-info">
              <WarningIcon size={12} />
              <span>{approval.title}</span>
            </div>
          ) : null}

          {tool.input !== undefined && tool.input !== '' ? (
            <div class="tool-io">
              <div class="tool-io-label">Input</div>
              <pre class="tool-pre">{formatInput(tool.input)}</pre>
            </div>
          ) : null}

          {tool.output !== undefined && tool.output !== '' ? (
            <div class="tool-io">
              <div class="tool-io-label">Output</div>
              <pre class="tool-pre">{tool.output}</pre>
            </div>
          ) : null}

          {tool.diff ? (
            <button
              type="button"
              class="tool-diff-btn"
              onClick={() => onOpenDiff(tool.id)}
              title={`Open diff for ${tool.diff.path}`}
            >
              <span class="tool-diff-path">{tool.diff.path}</span>
              <DiffStat diff={tool.diff} />
              <span class="tool-diff-open">Open diff</span>
            </button>
          ) : null}

          {tool.childSessionId !== undefined ? (
            <div class="tool-meta-row">
              <span>Sub-agent session</span>
              <code class="tool-code">{tool.childSessionId}</code>
            </div>
          ) : null}

          {elapsed !== null ? (
            <div class="tool-meta-row">
              <span>{statusText}</span>
              <span aria-hidden="true">·</span>
              <span>{elapsed}</span>
            </div>
          ) : null}

          {approval !== null && approval.detail !== undefined && approval.detail !== '' ? (
            <pre class="tool-pre tool-approval-detail">{approval.detail}</pre>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
