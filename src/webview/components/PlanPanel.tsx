/**
 * Plan/todo panel: DSH ships plan updates as `todo` tool calls whose output is
 * a markdown checklist. The panel pins the latest plan above the composer while
 * the agent still has work to do.
 */

import type { JSX } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { CheckIcon, ChevronIcon, PlanIcon } from '../icons';
import type { PlanItem } from '../plan';
import { shouldShowPlan, summarizePlan } from '../plan';

export interface PlanPanelProps {
  plan: readonly PlanItem[];
  running: boolean;
}

export function PlanPanel({ plan, running }: PlanPanelProps): JSX.Element | null {
  const [collapsed, setCollapsed] = useState(false);
  const summary = useMemo(() => summarizePlan(plan), [plan]);

  if (!shouldShowPlan(plan, running)) return null;

  const head = `Plan · ${summary.completed} of ${summary.total}`;

  return (
    <section class={`plan-panel${collapsed ? ' is-collapsed' : ''}`} aria-label="Plan">
      <button
        type="button"
        class="plan-head"
        aria-expanded={!collapsed}
        title={collapsed ? 'Expand plan' : 'Collapse plan'}
        onClick={() => setCollapsed((value) => !value)}
      >
        <PlanIcon size={13} />
        <span class="plan-title">{head}</span>
        {running ? <span class="plan-running" /> : null}
        <span class="plan-count">{summary.percent}%</span>
        <span class={`tool-chev plan-chev${collapsed ? ' chev-closed' : ' chev-open'}`}>
          <ChevronIcon size={12} />
        </span>
      </button>
      <div
        class="plan-progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={summary.percent}
        aria-label="Plan progress"
      >
        <span class="plan-progress-fill" style={{ width: `${summary.percent}%` }} />
      </div>
      {collapsed ? null : (
        <ul class="plan-items">
          {plan.map((item, index) => (
            <li class={`plan-item plan-${item.status}`} key={`${item.status}:${index}`}>
              <span class={`plan-glyph plan-glyph-${item.status}`} aria-hidden="true">
                {item.status === 'completed' ? <CheckIcon size={10} /> : null}
              </span>
              <span class="plan-text">{item.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
