/**
 * Small DOM-free helpers shared by the chat webview components.
 *
 * Everything here is pure so the components stay focused on markup.
 */

import type { Attachment, CommandInfo } from '../shared/protocol';

/** Last path segment, tolerating both separators and trailing slashes. */
export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

/** Short elapsed time label: `3s`, `42s`, `1m 5s`. */
export function formatDuration(milliseconds: number): string {
  const total = Math.max(1, Math.round(milliseconds / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/** Parses a tool `input` string that is expected to hold a JSON object. */
export function parseJsonObject(raw: string | undefined): Record<string, unknown> | null {
  if (raw === undefined || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** First non-empty string value among `keys` in a parsed tool input object. */
export function pickString(
  source: Record<string, unknown> | null,
  keys: readonly string[],
): string | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Slash-command menu                                                  */
/* ------------------------------------------------------------------ */

export type SlashItemKind = 'runtime' | 'local';

export interface SlashItem {
  kind: SlashItemKind;
  /** Command name without the leading `/`. */
  name: string;
  description: string;
}

interface LocalSlashAction {
  name: string;
  description: string;
}

const LOCAL_SLASH_ACTIONS: readonly LocalSlashAction[] = [
  { name: 'new', description: 'Start a new session' },
  { name: 'stop', description: 'Stop the running turn' },
  { name: 'model', description: 'Switch the model' },
  { name: 'permission', description: 'Change the permission preset' },
  { name: 'agent', description: 'Choose an agent preset' },
  { name: 'effort', description: 'Choose the reasoning effort' },
  { name: 'attach', description: 'Attach files, a selection or diagnostics' },
];

/** Hard cap on slash rows rendered at once (the list scrolls past it). */
export const SLASH_MENU_LIMIT = 10;

/**
 * Builds the slash menu: runtime commands first (they are what the DSH runtime
 * itself exposes), then the webview's local actions. `/stop` is only offered
 * while a turn is running.
 */
export function buildSlashItems(
  commands: readonly CommandInfo[],
  options: { running: boolean },
): SlashItem[] {
  const runtime: SlashItem[] = [];
  const seen = new Set<string>();
  for (const command of commands) {
    const name = command.name.trim().replace(/^\//, '');
    const key = name.toLowerCase();
    if (name === '' || seen.has(key)) continue;
    seen.add(key);
    runtime.push({ kind: 'runtime', name, description: command.description?.trim() ?? '' });
  }

  const local: SlashItem[] = [];
  for (const action of LOCAL_SLASH_ACTIONS) {
    if (action.name === 'stop' && !options.running) continue;
    local.push({ kind: 'local', name: action.name, description: action.description });
  }
  return [...runtime, ...local];
}

/** Case-insensitive filter: name prefix, then name substring, then description. */
export function filterSlashItems(items: readonly SlashItem[], query: string): SlashItem[] {
  const needle = query.trim().replace(/^\//, '').toLowerCase();
  if (needle === '') return items.slice(0, SLASH_MENU_LIMIT);

  const ranked: Array<{ item: SlashItem; rank: number; order: number }> = [];
  items.forEach((item, order) => {
    const name = item.name.toLowerCase();
    const rank = name.startsWith(needle)
      ? 0
      : name.includes(needle)
        ? 1
        : item.description.toLowerCase().includes(needle)
          ? 2
          : -1;
    if (rank >= 0) ranked.push({ item, rank, order });
  });
  ranked.sort((left, right) => left.rank - right.rank || left.order - right.order);
  return ranked.slice(0, SLASH_MENU_LIMIT).map((entry) => entry.item);
}

/**
 * The slash token being typed, or `null` when the draft is not a bare `/` word.
 * `'/comp'` -> `'comp'`, `'/'` -> `''`, `'/compact now'` -> `null`. A caret past
 * the first token also closes the menu, so text after the command does not keep
 * it open.
 */
export function slashQuery(text: string, caret = text.length): string | null {
  if (!text.startsWith('/')) return null;
  const rest = text.slice(1);
  const tokenEnd = /\s/.exec(rest)?.index ?? rest.length;
  if (caret > tokenEnd + 1) return null;
  return rest.slice(0, tokenEnd);
}

/* ------------------------------------------------------------------ */
/* `@` file mentions                                                   */
/* ------------------------------------------------------------------ */

export interface MentionToken {
  /** Text after the `@`, without the sigil. */
  query: string;
  /** Index of the `@` in the draft. */
  start: number;
  /** Caret index the token ends at. */
  end: number;
}

export const MENTION_MENU_LIMIT = 8;

/** The token after the `@` at the caret, while it has no whitespace in it. */
export function mentionTokenAt(text: string, caret: number): MentionToken | null {
  const end = Math.max(0, Math.min(caret, text.length));
  let index = end - 1;
  while (index >= 0) {
    const char = text.charAt(index);
    if (char === '@') {
      const before = index > 0 ? text.charAt(index - 1) : '';
      if (before !== '' && !/\s/.test(before)) return null;
      const query = text.slice(index + 1, end);
      return query === '' ? null : { query, start: index, end };
    }
    if (/\s/.test(char)) return null;
    index -= 1;
  }
  return null;
}

/** Inserts `@path ` over the mention token and returns the caret to place. */
export function insertMention(
  text: string,
  token: MentionToken,
  path: string,
): { text: string; caret: number } {
  const inserted = `@${path} `;
  return {
    text: `${text.slice(0, token.start)}${inserted}${text.slice(token.end)}`,
    caret: token.start + inserted.length,
  };
}

/**
 * Workspace-relative file suggestions for the mention menu. The host list is
 * already sorted, so a stable prefix/substring partition keeps that order.
 */
export function filterFileMentions(
  files: readonly string[],
  query: string,
  limit: number = MENTION_MENU_LIMIT,
): string[] {
  const needle = query.toLowerCase();
  if (needle === '') return files.slice(0, limit);

  const prefix: string[] = [];
  const contains: string[] = [];
  for (const file of files) {
    const path = file.toLowerCase();
    if (path.startsWith(needle) || basename(path).startsWith(needle)) prefix.push(file);
    else if (path.includes(needle)) contains.push(file);
  }
  return [...prefix, ...contains].slice(0, limit);
}

/** Mention syntax understood by the composer and by the host prompt builder. */
export const MENTION_PATTERN = /@([^\s@]+)/g;

/**
 * Mention paths present in the draft that exist in the workspace file list.
 * Trailing sentence punctuation is tolerated; duplicates are dropped.
 */
export function extractMentions(text: string, files: readonly string[]): string[] {
  const known = new Set(files);
  const found: string[] = [];
  const seen = new Set<string>();
  const pattern = new RegExp(MENTION_PATTERN.source, 'g');
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match !== null) {
    const raw = match[1] ?? '';
    const candidate = known.has(raw) ? raw : raw.replace(/[.,;:!?'")\]]+$/, '');
    if (known.has(candidate) && !seen.has(candidate)) {
      seen.add(candidate);
      found.push(candidate);
    }
    match = pattern.exec(text);
  }
  return found;
}

/** Appends mention attachments, skipping any label already attached. */
export function mergeMentionAttachments(
  attachments: readonly Attachment[],
  mentions: readonly string[],
): Attachment[] {
  const merged = attachments.slice();
  const seen = new Set(merged.map((attachment) => attachment.label));
  for (const mention of mentions) {
    if (seen.has(mention)) continue;
    seen.add(mention);
    merged.push({ kind: 'file', label: mention });
  }
  return merged;
}

/* ------------------------------------------------------------------ */
/* Usage footer                                                        */
/* ------------------------------------------------------------------ */

export interface UsageSummary {
  /** Prompt + completion tokens, when the host reported both. */
  tokens: number | null;
  contextUsed: number | null;
  contextWindow: number | null;
}

export const EMPTY_USAGE: UsageSummary = { tokens: null, contextUsed: null, contextWindow: null };

function trimTrailingZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value;
}

/** Compact token counts: `999`, `12.4k`, `1M`. */
export function formatCompactNumber(value: number): string {
  const rounded = Math.max(0, Math.round(value));
  if (rounded >= 999_950) return `${trimTrailingZero((rounded / 1_000_000).toFixed(1))}M`;
  if (rounded >= 1000) return `${trimTrailingZero((rounded / 1000).toFixed(1))}k`;
  return String(rounded);
}

/** Integer percentage of `window` used, or `null` when it is not computable. */
export function usagePercent(used: number | null, window: number | null): number | null {
  if (used === null || window === null) return null;
  if (!Number.isFinite(used) || !Number.isFinite(window) || window <= 0) return null;
  return Math.max(0, Math.round((used / window) * 100));
}

/** Footer pieces, e.g. `['12.4k tokens', '38% of 1M context']`. */
export function formatUsage(summary: UsageSummary | null): string[] {
  if (!summary) return [];
  const parts: string[] = [];
  if (summary.tokens !== null) parts.push(`${formatCompactNumber(summary.tokens)} tokens`);
  const window = summary.contextWindow;
  if (window !== null) {
    const percent = usagePercent(summary.contextUsed, window);
    parts.push(
      percent === null
        ? `${formatCompactNumber(window)} context`
        : `${percent}% of ${formatCompactNumber(window)} context`,
    );
  }
  return parts;
}

/** Native `title` tooltip for the usage footer (empty when nothing is known). */
export function usageTooltip(summary: UsageSummary | null): string {
  if (!summary) return '';
  const lines: string[] = [];
  if (summary.tokens !== null) lines.push(`${summary.tokens} tokens used in this session`);
  if (summary.contextUsed !== null && summary.contextWindow !== null) {
    lines.push(`Context: ${summary.contextUsed} of ${summary.contextWindow} tokens`);
  } else if (summary.contextWindow !== null) {
    lines.push(`Context window: ${summary.contextWindow} tokens`);
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Image attachments                                                   */
/* ------------------------------------------------------------------ */

export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/** 8 MiB of decoded image bytes. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function imageMediaType(mime: string): ImageMediaType | null {
  const normalized = mime.trim().toLowerCase();
  if (normalized === 'image/jpg') return 'image/jpeg';
  return IMAGE_MEDIA_TYPES.find((candidate) => candidate === normalized) ?? null;
}

/** Decoded byte length of a `data:` URL payload. */
export function dataUrlByteLength(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return 0;
  const payload = dataUrl.slice(comma + 1).replace(/=+$/, '');
  return Math.floor((payload.length * 3) / 4);
}

/** Splits `data:<mime>;base64,<payload>` and validates the media type. */
export function splitDataUrl(dataUrl: string): { mediaType: ImageMediaType | null; data: string } {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return { mediaType: null, data: '' };
  const header = dataUrl.slice(0, comma);
  const match = /^data:([^;]+);base64$/i.exec(header);
  return {
    mediaType: match ? imageMediaType(match[1] ?? '') : null,
    data: dataUrl.slice(comma + 1),
  };
}

