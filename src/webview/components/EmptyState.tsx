/**
 * Zero-message landing view: short intro, backend start/restart affordance,
 * keybinding hint and a few example prompts.
 */

import type { BackendStatus } from '../../shared/protocol';
import type { JSX } from 'preact';
import { RefreshIcon, SparkleIcon } from '../icons';

export interface EmptyStateProps {
  backendStatus: BackendStatus;
  backendDetail?: string;
  onStart(): void;
  onRestart(): void;
  onUseExample(text: string): void;
}

const EXAMPLES = [
  'Explain this codebase',
  'Find and fix a bug',
  'Add a test for the active file',
];

export function EmptyState({
  backendStatus,
  backendDetail,
  onStart,
  onRestart,
  onUseExample,
}: EmptyStateProps): JSX.Element {
  return (
    <div class="empty">
      <div class="empty-mark" aria-hidden="true">
        <SparkleIcon size={22} />
      </div>
      <h1 class="empty-title">DeepSeek Harness</h1>
      <p class="empty-intro">
        An agent for your workspace: read and edit files, run commands, and explain what it changed.
      </p>
      {backendStatus === 'stopped' && (
        <button type="button" class="btn btn-primary empty-start" onClick={onStart}>
          Start DSH
        </button>
      )}
      {backendStatus === 'error' && (
        <div class="empty-failure">
          <p class="empty-error">{backendDetail !== undefined && backendDetail !== '' ? backendDetail : 'The DSH backend failed to start.'}</p>
          <button type="button" class="btn btn-secondary empty-start" onClick={onRestart}>
            <RefreshIcon size={12} />
            <span>Restart DSH</span>
          </button>
        </div>
      )}
      {backendStatus === 'starting' && <p class="empty-status">Starting DSH backend…</p>}
      <p class="empty-hint">
        Focus this view anytime with <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd>
      </p>
      <div class="empty-examples">
        {EXAMPLES.map((example) => (
          <button type="button" class="example-btn" key={example} onClick={() => onUseExample(example)}>
            {example}
          </button>
        ))}
      </div>
    </div>
  );
}
