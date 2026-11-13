/**
 * Inline SVG icon set.
 *
 * The webview CSP forbids remote loads and codicon fonts are not guaranteed to
 * be present in the webview, so every icon is a 16x16 currentColor SVG.
 */

import type { ComponentChildren, JSX } from 'preact';

export interface IconProps {
  /** Pixel size, defaults to 16. */
  size?: number;
  class?: string;
}

interface IconBaseProps extends IconProps {
  children: ComponentChildren;
  filled?: boolean;
}

function IconBase({ size = 16, class: className, children, filled = false }: IconBaseProps): JSX.Element {
  return (
    <svg
      class={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      stroke-width={filled ? 0 : 1.5}
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      {children}
    </svg>
  );
}

export function SendIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M14.5 1.5 9.5 14.5 7 8.9 1.5 6.5 14.5 1.5Z" />
      <path d="M14.5 1.5 7 8.9" />
    </IconBase>
  );
}

export function StopIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props} filled>
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.6" />
    </IconBase>
  );
}

export function PlusIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M8 2.5v11M2.5 8h11" />
    </IconBase>
  );
}

export function SettingsIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props}>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" />
    </IconBase>
  );
}

export function RefreshIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M14 8a6 6 0 1 1-1.8-4.3" />
      <path d="M14.5 1.5v2.9h-2.9" />
    </IconBase>
  );
}

export function CheckIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M2.8 8.4 6.4 12 13.2 4" />
    </IconBase>
  );
}

export function CrossIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </IconBase>
  );
}

export function WarningIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M8 2 15 14H1L8 2Z" />
      <path d="M8 6.2v3.6M8 11.9v.6" />
    </IconBase>
  );
}

export function ChevronIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M3.5 6 8 10.5 12.5 6" />
    </IconBase>
  );
}

export function FileIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M4 1.8h4.6l3.2 3.2v9.2H4z" />
      <path d="M8.6 1.8v3.2h3.2" />
    </IconBase>
  );
}

export function SelectionIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M4.5 2.5H2.5v11h2M11.5 2.5h2v11h-2" />
      <path d="M8 5.5v5" />
    </IconBase>
  );
}

export function TerminalIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="m4.5 6.2 2.2 1.8-2.2 1.8M8.6 10h3.2" />
    </IconBase>
  );
}

export function CopyIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props}>
      <rect x="5.5" y="5.5" width="8" height="9" rx="1.2" />
      <path d="M10.5 5.5V3.7a1.2 1.2 0 0 0-1.2-1.2H3.7a1.2 1.2 0 0 0-1.2 1.2v5.6a1.2 1.2 0 0 0 1.2 1.2h1.8" />
    </IconBase>
  );
}

export function SessionsIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M2.5 2.5h11v7.5H7.5L4 13V10H2.5z" />
      <path d="M5.5 6h5M5.5 8h3" />
    </IconBase>
  );
}

export function ModelIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props}>
      <rect x="4" y="4" width="8" height="8" rx="1.2" />
      <path d="M6.2 1.5v2.5M9.8 1.5v2.5M6.2 12v2.5M9.8 12v2.5M1.5 6.2H4M1.5 9.8H4M12 6.2h2.5M12 9.8h2.5" />
    </IconBase>
  );
}

export function ShieldIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M8 1.5 13.5 3.5v4.2c0 3-2.3 5.3-5.5 6.6-3.2-1.3-5.5-3.6-5.5-6.6V3.5L8 1.5Z" />
    </IconBase>
  );
}

export function SparkleIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props} filled>
      <path d="M8 1.5 9.3 6.1 13.9 7.4 9.3 8.7 8 13.3 6.7 8.7 2.1 7.4 6.7 6.1 8 1.5Z" />
    </IconBase>
  );
}
