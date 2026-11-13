/**
 * Plan (todo) parsing for the chat webview.
 *
 * DSH reports its plan as a `todo` tool call whose `output` is a markdown task
 * list (`- [in_progress] Attach the cookie header`). This module turns that
 * text into typed rows and selects the most recent plan from `chat.tools`, so
 * the panel and the tests share one parser.
 */

import type { ToolCall } from '../shared/protocol';

export type PlanStatus = 'completed' | 'in_progress' | 'pending';

export interface PlanItem {
  text: string;
  status: PlanStatus;
}

export interface PlanSummary {
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
  /** Completed share, rounded to an integer percentage. */
  percent: number;
  active: boolean;
}

/** Markdown list item with a checkbox: `- [x] done`. */
const PLAN_LINE = /^\s*[-*+]\s*\[([^\]]*)\]\s*(.+?)\s*$/;

/** Tool names that carry a plan, for hosts that do not prefix ids with `todo-`. */
const PLAN_TOOL_NAMES: ReadonlySet<string> = new Set(['todo', 'todo_write', 'todowrite', 'update_plan']);

export function normalizePlanStatus(value: string): PlanStatus {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized === 'completed' || normalized === 'complete' || normalized === 'done' || normalized === 'x') {
    return 'completed';
  }
  if (normalized === 'in_progress' || normalized === 'active' || normalized === 'doing' || normalized === 'running') {
    return 'in_progress';
  }
  return 'pending';
}

/** Parses a todo tool output into plan rows; malformed lines are ignored. */
export function parsePlanOutput(output: string | undefined): PlanItem[] {
  if (output === undefined || output === '') return [];
  const items: PlanItem[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = PLAN_LINE.exec(line);
    if (!match) continue;
    const text = (match[2] ?? '').trim();
    if (text === '') continue;
    items.push({ text, status: normalizePlanStatus(match[1] ?? '') });
  }
  return items;
}

export function isPlanTool(tool: ToolCall): boolean {
  return tool.name === 'todo' || tool.id.startsWith('todo-') || PLAN_TOOL_NAMES.has(tool.name);
}

function sequenceOf(tool: ToolCall): number {
  const match = /(\d+)$/.exec(tool.id);
  return match ? Number(match[1]) : -1;
}

function newestFirst(left: ToolCall, right: ToolCall): number {
  return right.startedAt - left.startedAt || sequenceOf(right) - sequenceOf(left);
}

/**
 * The most recent parsed plan. Accepts `chat.tools` (a record) or a list of
 * tools, so tests and the panel can call it with either shape.
 */
export function selectPlan(
  tools: Readonly<Record<string, ToolCall>> | readonly ToolCall[],
): PlanItem[] {
  const list = Array.isArray(tools) ? tools : Object.values(tools as Record<string, ToolCall>);
  const candidates = list.filter(isPlanTool).sort(newestFirst);
  for (const candidate of candidates) {
    const plan = parsePlanOutput(candidate.output);
    if (plan.length > 0) return plan;
  }
  return [];
}

export function summarizePlan(plan: readonly PlanItem[]): PlanSummary {
  let completed = 0;
  let inProgress = 0;
  let pending = 0;
  for (const item of plan) {
    if (item.status === 'completed') completed += 1;
    else if (item.status === 'in_progress') inProgress += 1;
    else pending += 1;
  }
  const total = plan.length;
  return {
    total,
    completed,
    inProgress,
    pending,
    percent: total === 0 ? 0 : Math.round((completed / total) * 100),
    active: inProgress > 0 || pending > 0,
  };
}

/**
 * The panel is pinned above the composer while a turn runs or while the plan
 * still has open rows; a finished plan disappears once the agent is idle.
 */
export function shouldShowPlan(plan: readonly PlanItem[], running: boolean): boolean {
  if (plan.length === 0) return false;
  if (running) return true;
  return plan.some((item) => item.status !== 'completed');
}
