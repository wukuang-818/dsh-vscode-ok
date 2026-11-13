/**
 * Unit tests for the capability layer added in this batch: slash items, file
 * mentions, plan parsing, usage formatting and the session-search state slice.
 *
 * These tests import the pure helpers and the reducer, so they run in the node
 * environment without a DOM.
 */

import { describe, expect, it } from 'vitest';
import type { ChatState, CommandInfo, HostMessage, ToolCall } from '../src/shared/protocol';
import type { PlanItem } from '../src/webview/plan';
import {
  normalizePlanStatus,
  parsePlanOutput,
  selectPlan,
  shouldShowPlan,
  summarizePlan,
} from '../src/webview/plan';
import {
  createInitialState,
  emptyChatState,
  reduceApp,
  selectSessionSearch,
  selectUsage,
  type AppState,
} from '../src/webview/state';
import {
  buildSlashItems,
  extractMentions,
  filterFileMentions,
  filterSlashItems,
  formatCompactNumber,
  formatUsage,
  insertMention,
  mentionTokenAt,
  mergeMentionAttachments,
  slashQuery,
  usagePercent,
} from '../src/webview/util';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const COMMANDS: CommandInfo[] = [
  { name: 'compact', description: 'Compact the conversation' },
  { name: 'plan', description: 'Draft a plan' },
];

const FILES = [
  'README.md',
  'src/chat/controller.ts',
  'src/dsh/webClient.ts',
  'src/extension.ts',
];

function stateWith(chat: ChatState): AppState {
  return { ...createInitialState(), chat };
}

function toolCall(patch: Partial<ToolCall> & Pick<ToolCall, 'id'>): ToolCall {
  return {
    name: 'todo',
    title: 'Plan updated',
    status: 'done',
    startedAt: 0,
    ...patch,
  };
}

function planItems(items: PlanItem[]): PlanItem[] {
  return items;
}

/* ------------------------------------------------------------------ */
/* Slash menu                                                          */
/* ------------------------------------------------------------------ */

describe('slash commands', () => {
  it('puts runtime commands before local actions and strips a leading slash', () => {
    const items = buildSlashItems([{ name: '/compact', description: 'Compact' }], {
      running: false,
    });
    expect(items[0]).toEqual({ kind: 'runtime', name: 'compact', description: 'Compact' });
    expect(items.some((item) => item.kind === 'local')).toBe(true);
    expect(items.findIndex((item) => item.kind === 'runtime')).toBeLessThan(
      items.findIndex((item) => item.kind === 'local'),
    );
  });

  it('only offers /stop while a turn is running', () => {
    const idle = buildSlashItems([], { running: false }).map((item) => item.name);
    const busy = buildSlashItems([], { running: true }).map((item) => item.name);
    expect(idle).not.toContain('stop');
    expect(busy).toContain('stop');
  });

  it('deduplicates runtime commands case-insensitively', () => {
    const items = buildSlashItems(
      [
        { name: 'compact', description: 'first' },
        { name: 'Compact', description: 'second' },
      ],
      { running: false },
    );
    expect(items.filter((item) => item.kind === 'runtime')).toHaveLength(1);
    expect(items[0]?.description).toBe('first');
  });

  it('ranks name prefixes before substrings before descriptions', () => {
    const filtered = filterSlashItems(buildSlashItems(COMMANDS, { running: true }), 'plan');
    expect(filtered[0]?.name).toBe('plan');
    // `agent`/`permission` do not match; `attach` mentions "Attach files" only.
    expect(filtered.map((item) => item.name)).toContain('plan');
  });

  it('falls back to description matches', () => {
    const filtered = filterSlashItems(buildSlashItems(COMMANDS, { running: true }), 'conversation');
    expect(filtered.map((item) => item.name)).toEqual(['compact']);
  });

  it('caps the menu at ten rows', () => {
    const many: CommandInfo[] = Array.from({ length: 20 }, (_, index) => ({
      name: `cmd${index}`,
    }));
    expect(filterSlashItems(buildSlashItems(many, { running: true }), '')).toHaveLength(10);
  });

  it('reads the slash token and closes once whitespace follows', () => {
    expect(slashQuery('/')).toBe('');
    expect(slashQuery('/comp')).toBe('comp');
    expect(slashQuery('/compact now')).toBeNull();
    expect(slashQuery('hello /compact')).toBeNull();
  });

  it('closes when the caret leaves the first token', () => {
    expect(slashQuery('/compact now', 8)).toBe('compact');
    expect(slashQuery('/compact now', 10)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* File mentions                                                       */
/* ------------------------------------------------------------------ */

describe('file mentions', () => {
  it('extracts the token after the caret', () => {
    expect(mentionTokenAt('look at @cont', 13)).toEqual({ query: 'cont', start: 8, end: 13 });
  });

  it('rejects tokens that already contain whitespace', () => {
    expect(mentionTokenAt('@src/chat file', 13)).toBeNull();
  });

  it('rejects an @ glued to a word', () => {
    expect(mentionTokenAt('mail@example', 12)).toBeNull();
  });

  it('rejects an empty token', () => {
    expect(mentionTokenAt('hello @', 7)).toBeNull();
  });

  it('inserts the path with a trailing space', () => {
    const token = mentionTokenAt('open @we', 8);
    expect(token).not.toBeNull();
    if (!token) throw new Error('expected token');
    expect(insertMention('open @we now', token, 'src/dsh/webClient.ts')).toEqual({
      text: 'open @src/dsh/webClient.ts  now',
      caret: 27,
    });
  });

  it('prefers basename prefixes and caps the list at eight', () => {
    const files = Array.from({ length: 12 }, (_, index) => `lib/f${index}.ts`).concat(
      'src/webClient.ts',
    );
    const result = filterFileMentions(files, 'web');
    expect(result[0]).toBe('src/webClient.ts');
    expect(result.length).toBeLessThanOrEqual(8);
  });

  it('keeps only known workspace paths', () => {
    expect(extractMentions('fix @src/extension.ts and @nope.ts', FILES)).toEqual([
      'src/extension.ts',
    ]);
  });

  it('tolerates trailing punctuation', () => {
    expect(extractMentions('see @README.md.', FILES)).toEqual(['README.md']);
  });

  it('deduplicates repeated mentions', () => {
    expect(extractMentions('@README.md again @README.md', FILES)).toEqual(['README.md']);
  });

  it('appends mention attachments after the existing ones', () => {
    const merged = mergeMentionAttachments(
      [{ kind: 'image', label: 'shot.png', mediaType: 'image/png', data: 'AA' }],
      ['README.md'],
    );
    expect(merged).toHaveLength(2);
    expect(merged[1]).toEqual({ kind: 'file', label: 'README.md' });
  });

  it('does not duplicate a label that is already attached', () => {
    const existing = [{ kind: 'file' as const, label: 'README.md' }];
    expect(mergeMentionAttachments(existing, ['README.md', 'src/extension.ts'])).toEqual([
      { kind: 'file', label: 'README.md' },
      { kind: 'file', label: 'src/extension.ts' },
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* Plan                                                                */
/* ------------------------------------------------------------------ */

describe('plan parsing', () => {
  it('maps the three todo statuses', () => {
    const plan = parsePlanOutput(
      '- [completed] Capture the cookie\n- [in_progress] Attach the header\n- [pending] Re-open the stream',
    );
    expect(planItems(plan)).toEqual([
      { text: 'Capture the cookie', status: 'completed' },
      { text: 'Attach the header', status: 'in_progress' },
      { text: 'Re-open the stream', status: 'pending' },
    ]);
  });

  it('ignores malformed lines but keeps unchecked boxes', () => {
    const plan = parsePlanOutput('intro\n- plain bullet\n- [ ] no text\n- [pending] real');
    expect(plan).toEqual([
      { text: 'no text', status: 'pending' },
      { text: 'real', status: 'pending' },
    ]);
  });

  it('defaults unknown statuses to pending', () => {
    expect(normalizePlanStatus('deferred')).toBe('pending');
    expect(normalizePlanStatus('DONE')).toBe('completed');
    expect(normalizePlanStatus('in-progress')).toBe('in_progress');
  });

  it('selects the newest plan from a tool record', () => {
    const tools: Record<string, ToolCall> = {
      'todo-1': toolCall({ id: 'todo-1', startedAt: 10, output: '- [pending] old' }),
      'todo-2': toolCall({ id: 'todo-2', startedAt: 20, output: '- [pending] new' }),
    };
    expect(selectPlan(tools)).toEqual([{ text: 'new', status: 'pending' }]);
  });

  it('skips non-plan tools', () => {
    const tools: Record<string, ToolCall> = {
      'tool-1': toolCall({ id: 'tool-1', name: 'str_replace_editor', output: '- [pending] nope' }),
    };
    expect(selectPlan(tools)).toEqual([]);
  });

  it('summarizes counts and progress', () => {
    const summary = summarizePlan([
      { text: 'a', status: 'completed' },
      { text: 'b', status: 'in_progress' },
      { text: 'c', status: 'pending' },
    ]);
    expect(summary).toEqual({
      total: 3,
      completed: 1,
      inProgress: 1,
      pending: 1,
      percent: 33,
      active: true,
    });
  });

  it('hides a finished plan when the agent is idle', () => {
    const done: PlanItem[] = [{ text: 'a', status: 'completed' }];
    expect(shouldShowPlan(done, false)).toBe(false);
    expect(shouldShowPlan(done, true)).toBe(true);
    expect(shouldShowPlan([], false)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Usage                                                               */
/* ------------------------------------------------------------------ */

describe('usage footer', () => {
  it('derives tokens from input plus output', () => {
    const chat = emptyChatState();
    chat.session = { ...chat.session, usage: { inputTokens: 10_000, outputTokens: 2_400 } };
    expect(selectUsage(stateWith(chat))).toEqual({
      tokens: 12_400,
      contextUsed: null,
      contextWindow: null,
    });
  });

  it('accepts raw tokenUsage and contextPressure shapes', () => {
    const chat = emptyChatState();
    chat.session = {
      ...chat.session,
      usage: {
        tokenUsage: { total: 31_000 },
        contextPressure: { used: 380_000, total: 1_000_000 },
      } as unknown as ChatState['session']['usage'],
    };
    expect(selectUsage(stateWith(chat))).toEqual({
      tokens: 31_000,
      contextUsed: 380_000,
      contextWindow: 1_000_000,
    });
  });

  it('returns null when nothing is known', () => {
    expect(selectUsage(stateWith(emptyChatState()))).toBeNull();
  });

  it('formats tokens and context percentage', () => {
    expect(
      formatUsage({ tokens: 12_400, contextUsed: 380_000, contextWindow: 1_000_000 }),
    ).toEqual(['12.4k tokens', '38% of 1M context']);
  });

  it('renders a window without a used value', () => {
    expect(formatUsage({ tokens: null, contextUsed: null, contextWindow: 200_000 })).toEqual([
      '200k context',
    ]);
  });

  it('rounds compact numbers', () => {
    expect(formatCompactNumber(999)).toBe('999');
    expect(formatCompactNumber(1_050)).toBe('1.1k');
    expect(formatCompactNumber(1_000_000)).toBe('1M');
    expect(usagePercent(500_000, 1_000_000)).toBe(50);
    expect(usagePercent(1, 0)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Session search + capability slices                                  */
/* ------------------------------------------------------------------ */

describe('capability state slices', () => {
  it('stores search results and clears them when the query changes', () => {
    const initial = stateWith(emptyChatState());
    const withHits = reduceApp(initial, {
      type: 'host',
      message: {
        type: 'search-results',
        items: [{ sessionId: 's1', snippet: 'cookie header' }],
      } satisfies HostMessage,
    });
    expect(selectSessionSearch(withHits)).toEqual([{ sessionId: 's1', snippet: 'cookie header' }]);

    const cleared = reduceApp(withHits, { type: 'clear-search' });
    expect(selectSessionSearch(cleared)).toEqual([]);
  });

  it('fills files, commands and skills from host messages', () => {
    let state = stateWith(emptyChatState());
    state = reduceApp(state, {
      type: 'host',
      message: { type: 'files', files: FILES },
    });
    state = reduceApp(state, {
      type: 'host',
      message: { type: 'commands', commands: COMMANDS },
    });
    state = reduceApp(state, {
      type: 'host',
      message: {
        type: 'skills',
        skills: [{ name: 'office', description: 'Create and edit Office documents' }],
      },
    });
    expect(state.chat?.files).toEqual(FILES);
    expect(state.chat?.commands).toHaveLength(2);
    expect(state.chat?.skills[0]?.name).toBe('office');
  });

  it('keeps search results across unrelated host messages', () => {
    const state = reduceApp(stateWith(emptyChatState()), {
      type: 'host',
      message: { type: 'search-results', items: [{ sessionId: 's1', snippet: 'hit' }] },
    });
    const next = reduceApp(state, {
      type: 'host',
      message: { type: 'files', files: FILES },
    });
    expect(selectSessionSearch(next)).toHaveLength(1);
  });
});
