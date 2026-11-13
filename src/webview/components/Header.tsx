/**
 * Compact chat header: brand, backend status, session picker and the model /
 * permission / agent chips. Everything is an icon button with an `aria-label`
 * because the Secondary Sidebar is narrow.
 */

import type { ChatState, PermissionPreset } from '../../shared/protocol';
import { PERMISSION_PRESETS } from '../../shared/protocol';
import type { JSX } from 'preact';
import {
  ModelIcon,
  PlusIcon,
  RefreshIcon,
  SessionsIcon,
  SettingsIcon,
  ShieldIcon,
  SparkleIcon,
  StopIcon,
} from '../icons';

export interface HeaderProps {
  chat: ChatState | null;
  onNewChat(): void;
  onOpenSessions(): void;
  onStop(): void;
  onSettings(): void;
  onPickModel(): void;
  onPickPermission(): void;
  onPickAgent(): void;
  onStartBackend(): void;
}

const BACKEND_LABELS: Record<ChatState['backend']['status'], string> = {
  stopped: 'Stopped',
  starting: 'Starting',
  ready: 'Ready',
  error: 'Error',
};

function permissionLabel(preset: PermissionPreset | undefined): string {
  if (!preset) return 'Permission';
  const match = PERMISSION_PRESETS.find((candidate) => candidate.id === preset);
  return match ? match.label : preset;
}

export function Header({
  chat,
  onNewChat,
  onOpenSessions,
  onStop,
  onSettings,
  onPickModel,
  onPickPermission,
  onPickAgent,
  onStartBackend,
}: HeaderProps): JSX.Element {
  const status = chat?.backend.status ?? 'starting';
  const running = chat?.session.running ?? false;
  const workspace = chat?.workspace.name ?? '';
  const permission = chat?.session.permission;
  const model = chat?.session.model?.label ?? 'Model';
  const agentPresetId = chat?.session.agentPreset ?? null;
  const agentPreset = chat?.agentPresets.find((preset) => preset.id === agentPresetId);
  const agent = agentPreset?.name ?? agentPresetId ?? 'Agent';
  const sessionTitle = chat?.session.title ?? 'New chat';
  const needsStart = status === 'stopped' || status === 'error';

  return (
    <header class="header">
      <div class="header-row">
        <span class="brand">dsh-vscode-ok</span>
        {workspace !== '' && (
          <span class="workspace" title={chat?.workspace.cwd ?? workspace}>
            {workspace}
          </span>
        )}
        <span class="spacer" />
        {running && (
          <button type="button" class="icon-btn" title="Stop the running turn" aria-label="Stop" onClick={onStop}>
            <StopIcon />
          </button>
        )}
        <button type="button" class="icon-btn" title="New chat" aria-label="New chat" onClick={onNewChat}>
          <PlusIcon />
        </button>
        <button
          type="button"
          class="icon-btn"
          title="Switch session"
          aria-label="Switch session"
          onClick={onOpenSessions}
        >
          <SessionsIcon />
        </button>
        {needsStart && (
          <button
            type="button"
            class="icon-btn"
            title={status === 'error' ? 'Restart the backend' : 'Start the backend'}
            aria-label={status === 'error' ? 'Restart backend' : 'Start backend'}
            onClick={onStartBackend}
          >
            <RefreshIcon />
          </button>
        )}
        <button type="button" class="icon-btn" title="Settings" aria-label="Settings" onClick={onSettings}>
          <SettingsIcon />
        </button>
      </div>
      <div class="header-row header-chips">
        <span
          class={`status-chip status-${status}`}
          title={chat?.backend.detail ?? BACKEND_LABELS[status]}
        >
          <span class="status-dot" aria-hidden="true" />
          {BACKEND_LABELS[status]}
        </span>
        <button
          type="button"
          class="chip"
          title={`Session: ${sessionTitle}`}
          onClick={onOpenSessions}
        >
          <SessionsIcon size={12} />
          <span class="chip-text">{sessionTitle}</span>
          {running && <span class="badge">running</span>}
        </button>
        <button type="button" class="chip" title="Select model" onClick={onPickModel}>
          <ModelIcon size={12} />
          <span class="chip-text">{model}</span>
        </button>
        <button
          type="button"
          class={`chip${permission === 'danger-full-access' ? ' chip-warning' : ''}`}
          title="Select permission preset"
          onClick={onPickPermission}
        >
          <ShieldIcon size={12} />
          <span class="chip-text">{permissionLabel(permission)}</span>
        </button>
        <button type="button" class="chip" title="Select agent preset" onClick={onPickAgent}>
          <SparkleIcon size={12} />
          <span class="chip-text">{agent}</span>
        </button>
      </div>
    </header>
  );
}
