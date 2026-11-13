/**
 * Composer: auto-growing textarea, attachment chips, the Copilot-style bottom
 * toolbar (attach menu, model / permission / agent / effort pills, send or
 * stop) and the two keyboard menus that surface DSH capabilities:
 *
 * - `/` opens the slash menu: runtime commands from `chat.commands` first, then
 *   the webview's local actions.
 * - `@` opens the file mention menu backed by `chat.files`.
 *
 * Images pasted or dropped on the box become `image` attachments (data URL
 * payload, shape validated before it reaches the host).
 */

import type {
  Attachment,
  BackendStatus,
  CommandInfo,
  PermissionPreset,
  SkillInfo,
} from '../../shared/protocol';
import { PERMISSION_PRESETS } from '../../shared/protocol';
import type { Draft } from '../state';
import type { JSX } from 'preact';
import { Fragment } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useDismiss } from '../hooks';
import {
  AgentIcon,
  ArrowUpIcon,
  BookIcon,
  CrossIcon,
  FileIcon,
  GaugeIcon,
  ImageIcon,
  ModelIcon,
  PlusIcon,
  PulseIcon,
  SelectionIcon,
  ShieldIcon,
  SlashIcon,
  SparkleIcon,
  StopIcon,
  TerminalIcon,
} from '../icons';
import type { SlashItem, UsageSummary } from '../util';
import {
  MAX_IMAGE_BYTES,
  dataUrlByteLength,
  filterFileMentions,
  filterSlashItems,
  formatUsage,
  imageMediaType,
  insertMention,
  mentionTokenAt,
  slashQuery,
  splitDataUrl,
  buildSlashItems,
  usageTooltip,
} from '../util';

export interface ComposerProps {
  draft: Draft;
  backendStatus: BackendStatus;
  running: boolean;
  modelLabel: string;
  permission: PermissionPreset;
  agentLabel: string | null;
  /** `null` when the current model exposes no reasoning efforts. */
  effortLabel: string | null;
  usage: UsageSummary | null;
  commands: readonly CommandInfo[];
  files: readonly string[];
  skills: readonly SkillInfo[];
  textareaRef: { current: HTMLTextAreaElement | null };
  onSend(): void;
  onStop(): void;
  onChange(text: string): void;
  onNewSession(): void;
  onAttachFiles(): void;
  onAttachSelection(): void;
  onAttachProblems(): void;
  onAddAttachment(attachment: Attachment): void;
  onRemoveAttachment(index: number): void;
  onPickModel(): void;
  onPickPermission(): void;
  onPickAgent(): void;
  onPickEffort(): void;
  onRequestFiles(query: string): void;
  onExecuteCommand(name: string, line: string): void;
}

const MAX_TEXTAREA_HEIGHT = 180;

/** Debounce before asking the host for workspace files for a mention token. */
const MENTION_DEBOUNCE_MS = 120;

const PLACEHOLDERS: Record<BackendStatus, string> = {
  ready: 'Ask dsh-vscode-ok or type / for actions',
  starting: 'Starting the backend…',
  stopped: 'Start the backend to chat',
  error: 'Backend unavailable',
};

function attachmentIcon(kind: Attachment['kind']): JSX.Element {
  if (kind === 'selection') return <SelectionIcon size={12} />;
  if (kind === 'diagnostics') return <PulseIcon size={12} />;
  if (kind === 'terminal') return <TerminalIcon size={12} />;
  if (kind === 'image') return <ImageIcon size={12} />;
  return <FileIcon size={12} />;
}

function attachmentPreview(attachment: Attachment): string | undefined {
  if (attachment.kind !== 'image' || !attachment.data || !attachment.mediaType) return undefined;
  return `data:${attachment.mediaType};base64,${attachment.data}`;
}

function permissionLabel(permission: PermissionPreset): string {
  return PERMISSION_PRESETS.find((preset) => preset.id === permission)?.label ?? permission;
}

function skillTooltip(skills: readonly SkillInfo[]): string {
  return skills
    .map((skill) => (skill.description ? `${skill.name}: ${skill.description}` : skill.name))
    .join('\n');
}

function dragHasFiles(transfer: DataTransfer | null): boolean {
  if (!transfer) return false;
  return Array.from(transfer.types).includes('Files');
}

function imageFiles(list: FileList | null): File[] {
  if (!list) return [];
  return Array.from(list).filter((file) => file.type.startsWith('image/'));
}

interface AttachMenuItem {
  label: string;
  hint: string;
  icon: JSX.Element;
  action(): void;
}

export function Composer({
  draft,
  backendStatus,
  running,
  modelLabel,
  permission,
  agentLabel,
  effortLabel,
  usage,
  commands,
  files,
  skills,
  textareaRef,
  onSend,
  onStop,
  onChange,
  onNewSession,
  onAttachFiles,
  onAttachSelection,
  onAttachProblems,
  onAddAttachment,
  onRemoveAttachment,
  onPickModel,
  onPickPermission,
  onPickAgent,
  onPickEffort,
  onRequestFiles,
  onExecuteCommand,
}: ComposerProps): JSX.Element {
  const ready = backendStatus === 'ready';

  const [attachOpen, setAttachOpen] = useState(false);
  const attachRef = useRef<HTMLDivElement | null>(null);
  useDismiss(attachOpen, attachRef, () => setAttachOpen(false));

  const [caret, setCaret] = useState(0);
  const [slashIndex, setSlashIndex] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  const hasText = draft.text.trim().length > 0;
  const canSend = ready && !running && hasText;

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    const next = Math.min(element.scrollHeight, MAX_TEXTAREA_HEIGHT);
    element.style.height = `${next}px`;
    element.style.overflowY = element.scrollHeight > MAX_TEXTAREA_HEIGHT ? 'auto' : 'hidden';
  }, [draft.text, textareaRef]);

  /* -- image errors ------------------------------------------------- */

  useEffect(() => {
    if (imageError === null) return;
    const timer = window.setTimeout(() => setImageError(null), 6000);
    return () => window.clearTimeout(timer);
  }, [imageError]);

  /* -- slash menu --------------------------------------------------- */

  const slashItems = useMemo(
    () => buildSlashItems(commands, { running }),
    [commands, running],
  );
  const slashToken = slashQuery(draft.text, caret);
  const slashMatches = useMemo(
    () => (slashToken === null ? [] : filterSlashItems(slashItems, slashToken)),
    [slashItems, slashToken],
  );
  const slashOpen = slashMatches.length > 0 && dismissed !== draft.text;
  const activeSlash = Math.min(slashIndex, Math.max(0, slashMatches.length - 1));

  /* -- mention menu ------------------------------------------------- */

  const mention = useMemo(() => mentionTokenAt(draft.text, caret), [draft.text, caret]);
  const mentionMatches = useMemo(
    () => (mention === null ? [] : filterFileMentions(files, mention.query)),
    [files, mention],
  );
  const mentionOpen = mention !== null && mentionMatches.length > 0 && dismissed !== draft.text;
  const activeMention = Math.min(mentionIndex, Math.max(0, mentionMatches.length - 1));

  const mentionQuery = mention?.query ?? null;

  useEffect(() => {
    if (mentionQuery === null) return;
    const query = mentionQuery;
    const timer = window.setTimeout(() => onRequestFiles(query), MENTION_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [mentionQuery, onRequestFiles]);

  /* -- selection helpers -------------------------------------------- */

  const syncCaret = (element: HTMLTextAreaElement): void => {
    setCaret(element.selectionStart ?? 0);
  };

  const focusAt = (position: number): void => {
    const element = textareaRef.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(position, position);
    setCaret(position);
  };

  /* -- choosing ----------------------------------------------------- */

  const localActions = useMemo<Record<string, () => void>>(
    () => ({
      new: onNewSession,
      stop: onStop,
      model: onPickModel,
      permission: onPickPermission,
      agent: onPickAgent,
      effort: onPickEffort,
      attach: onAttachFiles,
    }),
    [
      onNewSession,
      onStop,
      onPickModel,
      onPickPermission,
      onPickAgent,
      onPickEffort,
      onAttachFiles,
    ],
  );

  const chooseSlash = (item: SlashItem): void => {
    setDismissed(null);
    setSlashIndex(0);
    if (item.kind === 'runtime') onExecuteCommand(item.name, `/${item.name}`);
    else localActions[item.name]?.();
    onChange('');
    setCaret(0);
    focusAt(0);
  };

  const chooseMention = (path: string): void => {
    if (!mention) return;
    const inserted = insertMention(draft.text, mention, path);
    setDismissed(null);
    setMentionIndex(0);
    onChange(inserted.text);
    focusAt(inserted.caret);
  };

  /* -- images ------------------------------------------------------- */

  const addImage = (file: File): void => {
    const declared = imageMediaType(file.type);
    if (!declared) {
      setImageError('Unsupported image type. Use PNG, JPEG, WebP or GIF.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const { mediaType, data } = splitDataUrl(result);
      if (!mediaType || data === '') {
        setImageError('Could not read that image.');
        return;
      }
      if (dataUrlByteLength(result) > MAX_IMAGE_BYTES) {
        setImageError('Image is larger than 8 MiB when decoded.');
        return;
      }
      onAddAttachment({
        kind: 'image',
        label: file.name || 'pasted image',
        mediaType,
        data,
      });
    };
    reader.onerror = () => setImageError('Could not read that image.');
    reader.readAsDataURL(file);
  };

  /* -- attach menu -------------------------------------------------- */

  const attachItems = useMemo<AttachMenuItem[]>(
    () => [
      {
        label: 'Attach files',
        hint: 'Pick files from the workspace',
        icon: <FileIcon size={14} />,
        action: onAttachFiles,
      },
      {
        label: 'Attach selection',
        hint: 'Use the active editor selection',
        icon: <SelectionIcon size={14} />,
        action: onAttachSelection,
      },
      {
        label: 'Attach problems',
        hint: 'Include current diagnostics',
        icon: <PulseIcon size={14} />,
        action: onAttachProblems,
      },
    ],
    [onAttachFiles, onAttachSelection, onAttachProblems],
  );

  const chooseAttach = (item: AttachMenuItem): void => {
    setAttachOpen(false);
    item.action();
  };

  const submit = (): void => {
    if (!canSend) return;
    onSend();
  };

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (slashOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSlashIndex((index) => (index + 1) % slashMatches.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSlashIndex((index) => (index - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const item = slashMatches[activeSlash];
        if (item) {
          event.preventDefault();
          chooseSlash(item);
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setDismissed(draft.text);
        return;
      }
    }

    if (mentionOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMentionIndex((index) => (index + 1) % mentionMatches.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMentionIndex((index) => (index - 1 + mentionMatches.length) % mentionMatches.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const path = mentionMatches[activeMention];
        if (path) {
          event.preventDefault();
          chooseMention(path);
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setDismissed(draft.text);
        return;
      }
    }

    if (event.key === '/' && !event.shiftKey && caret === 0 && !draft.text.startsWith('/')) {
      event.preventDefault();
      setDismissed(null);
      onChange(`/${draft.text}`);
      focusAt(1);
      return;
    }

    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    submit();
  };

  const usageParts = formatUsage(usage);
  const usageTitle = usageTooltip(usage);
  const imageSource = (attachment: Attachment): string | undefined => attachmentPreview(attachment);

  return (
    <div class="composer">
      <div
        class={`composer-box${running ? ' is-running' : ''}${dragging ? ' is-dragging' : ''}`}
        onDragOver={(event) => {
          if (!dragHasFiles(event.dataTransfer)) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          const images = imageFiles(event.dataTransfer?.files ?? null);
          setDragging(false);
          if (images.length === 0) return;
          event.preventDefault();
          images.forEach(addImage);
        }}
      >
        {slashOpen ? (
          <div class="composer-popup slash-menu" role="listbox" aria-label="Commands">
            {slashMatches.map((item, index) => {
              const previous = index > 0 ? slashMatches[index - 1] : undefined;
              const showGroup = previous === undefined || previous.kind !== item.kind;
              return (
                <Fragment key={`${item.kind}:${item.name}`}>
                  {showGroup ? (
                    <div class="slash-group">
                      {item.kind === 'runtime' ? 'Commands' : 'Actions'}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === activeSlash}
                    class={`slash-item${index === activeSlash ? ' is-active' : ''}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setSlashIndex(index)}
                    onClick={() => chooseSlash(item)}
                  >
                    <span class="slash-item-icon">
                      {item.kind === 'runtime' ? <SlashIcon size={13} /> : <SparkleIcon size={13} />}
                    </span>
                    <span class="slash-item-name">/{item.name}</span>
                    <span class="slash-item-desc">{item.description}</span>
                  </button>
                </Fragment>
              );
            })}
          </div>
        ) : null}

        {mentionOpen ? (
          <div class="composer-popup mention-menu" role="listbox" aria-label="Files">
            {mentionMatches.map((path, index) => (
              <button
                key={path}
                type="button"
                role="option"
                aria-selected={index === activeMention}
                class={`mention-item${index === activeMention ? ' is-active' : ''}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setMentionIndex(index)}
                onClick={() => chooseMention(path)}
              >
                <FileIcon size={12} />
                <span class="mention-path">{path}</span>
              </button>
            ))}
          </div>
        ) : null}

        {draft.attachments.length > 0 ? (
          <div class="composer-attachments">
            {draft.attachments.map((attachment, index) => {
              const source = imageSource(attachment);
              return (
                <span
                  class={`attach-chip${attachment.kind === 'image' ? ' is-image' : ''}`}
                  key={`${attachment.kind}:${attachment.path ?? attachment.label}:${index}`}
                  title={attachment.path ?? attachment.label}
                >
                  {source ? (
                    <img class="attach-thumb" src={source} alt={attachment.label} />
                  ) : (
                    attachmentIcon(attachment.kind)
                  )}
                  <span class="attach-chip-label">{attachment.label}</span>
                  <button
                    type="button"
                    class="attach-remove"
                    aria-label={`Remove ${attachment.label}`}
                    title={`Remove ${attachment.label}`}
                    onClick={() => onRemoveAttachment(index)}
                  >
                    <CrossIcon size={10} />
                  </button>
                </span>
              );
            })}
          </div>
        ) : null}

        <textarea
          ref={textareaRef}
          class="composer-input"
          rows={1}
          value={draft.text}
          placeholder={PLACEHOLDERS[backendStatus]}
          aria-label="Message"
          title="Enter to send, Shift+Enter for a newline"
          disabled={!ready}
          onInput={(event) => {
            onChange(event.currentTarget.value);
            syncCaret(event.currentTarget);
            setDismissed(null);
          }}
          onClick={(event) => syncCaret(event.currentTarget)}
          onSelect={(event) => syncCaret(event.currentTarget)}
          onKeyUp={(event) => syncCaret(event.currentTarget)}
          onKeyDown={handleKeyDown}
          onPaste={(event) => {
            const items = event.clipboardData?.items;
            if (!items) return;
            const images: File[] = [];
            for (const item of Array.from(items)) {
              if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
              const file = item.getAsFile();
              if (file) images.push(file);
            }
            if (images.length === 0) return;
            event.preventDefault();
            images.forEach(addImage);
          }}
        />

        {imageError !== null ? (
          <div class="composer-error" role="alert">
            <span class="composer-error-text">{imageError}</span>
          </div>
        ) : null}

        <div class="composer-toolbar">
          <div class="menu-anchor" ref={attachRef}>
            <button
              type="button"
              class="icon-btn composer-attach"
              aria-label="Add context"
              title="Add context (or drop an image)"
              aria-haspopup="menu"
              aria-expanded={attachOpen}
              disabled={!ready}
              onClick={() => setAttachOpen((open) => !open)}
            >
              <PlusIcon size={16} />
            </button>
            {attachOpen ? (
              <div class="menu composer-menu" role="menu" aria-label="Add context">
                {attachItems.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    class="menu-item"
                    role="menuitem"
                    title={item.hint}
                    onClick={() => chooseAttach(item)}
                  >
                    <span class="menu-item-icon">{item.icon}</span>
                    <span class="menu-item-text">
                      <span class="menu-item-label">{item.label}</span>
                      <span class="menu-item-hint">{item.hint}</span>
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <button
            type="button"
            class="pill pill-model"
            title={`Change model (${modelLabel})`}
            aria-label={`Change model, current ${modelLabel}`}
            disabled={!ready}
            onClick={onPickModel}
          >
            <ModelIcon size={13} />
            <span class="pill-label">{modelLabel}</span>
          </button>

          <button
            type="button"
            class="pill pill-permission"
            title={`Change permission (${permissionLabel(permission)})`}
            aria-label={`Change permission, current ${permissionLabel(permission)}`}
            disabled={!ready}
            onClick={onPickPermission}
          >
            <ShieldIcon size={13} />
            <span class="pill-label">{permissionLabel(permission)}</span>
          </button>

          <button
            type="button"
            class="pill pill-agent"
            title={`Change agent (${agentLabel ?? 'default'})`}
            aria-label={`Change agent, current ${agentLabel ?? 'default'}`}
            disabled={!ready}
            onClick={onPickAgent}
          >
            <AgentIcon size={13} />
            <span class="pill-label">{agentLabel ?? 'Default agent'}</span>
          </button>

          {effortLabel !== null ? (
            <button
              type="button"
              class="pill pill-effort"
              title={`Reasoning effort: ${effortLabel}`}
              aria-label={`Change reasoning effort, current ${effortLabel}`}
              disabled={!ready}
              onClick={onPickEffort}
            >
              <GaugeIcon size={13} />
              <span class="pill-label">{effortLabel}</span>
            </button>
          ) : null}

          {skills.length > 0 ? (
            <span
              class="pill pill-skills is-readonly"
              title={skillTooltip(skills)}
              aria-label={`${skills.length} skills available`}
            >
              <BookIcon size={13} />
              <span class="pill-label">
                {skills.length === 1 ? skills[0]?.name : `${skills.length} skills`}
              </span>
            </span>
          ) : null}

          <span class="toolbar-spacer" />

          {running ? (
            <button
              type="button"
              class="send-btn is-stop"
              aria-label="Stop generating"
              title="Stop generating"
              onClick={onStop}
            >
              <StopIcon size={12} />
            </button>
          ) : (
            <button
              type="button"
              class="send-btn"
              aria-label="Send message"
              title={canSend ? 'Send (Enter)' : hasText ? 'Backend not ready' : 'Type a message'}
              disabled={!canSend}
              onClick={submit}
            >
              <ArrowUpIcon size={15} />
            </button>
          )}
        </div>
      </div>

      {usageParts.length > 0 ? (
        <div class="composer-footer" title={usageTitle}>
          <span class="composer-usage">{usageParts.join(' · ')}</span>
        </div>
      ) : null}
    </div>
  );
}
