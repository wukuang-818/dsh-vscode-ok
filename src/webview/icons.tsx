/**
 * Inline SVG icon set.
 *
 * The webview CSP forbids remote loads and codicon fonts are not guaranteed to
 * be present in the webview, so every icon is a 16x16 currentColor SVG. Icons are
 * decorative by default (`aria-hidden`); the surrounding button carries the
 * accessible name.
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
      focusable="false"
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

/* ------------------------------------------------------------------ */
/* Composer and header                                                 */
/* ------------------------------------------------------------------ */

export function ArrowUpIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M8 13.2V3" />
      <path d="M3.8 7.2 8 3l4.2 4.2" />
    </IconBase>
  );
}

export function StopIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props} filled>
      <rect x="3.6" y="3.6" width="8.8" height="8.8" rx="1.4" />
    </IconBase>
  );
}

export function PlusIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M8 2.8v10.4M2.8 8h10.4" />
    </IconBase>
  );
}

export function EllipsisIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props} filled>
      <circle cx="3.2" cy="8" r="1.25" />
      <circle cx="8" cy="8" r="1.25" />
      <circle cx="12.8" cy="8" r="1.25" />
    </IconBase>
  );
}

export function HistoryIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M2.7 8a5.3 5.3 0 1 0 1.6-3.8" />
      <path d="M2.3 2.4v3.1h3.1" />
      <path d="M8 5v3.2l2.2 1.4" />
    </IconBase>
  );
}

export function SettingsIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props}>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.7v1.9M8 12.4v1.9M1.7 8h1.9M12.4 8h1.9M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M12.5 3.5l-1.4 1.4M4.9 11.1l-1.4 1.4" />
    </IconBase>
  );
}

export function RefreshIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M13.8 8a5.8 5.8 0 1 1-1.7-4.1" />
      <path d="M14.2 1.8v2.8h-2.8" />
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

export function SearchIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props}>
      <circle cx="7.2" cy="7.2" r="4.4" />
      <path d="m10.5 10.5 3 3" />
    </IconBase>
  );
}

/* ------------------------------------------------------------------ */
/* Attachments                                                         */
/* ------------------------------------------------------------------ */

export function AttachIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M12.9 6.6 7.1 12.4a3.1 3.1 0 0 1-4.4-4.4l6-6a2.1 2.1 0 0 1 3 3l-5.8 5.8a1.05 1.05 0 0 1-1.5-1.5l5.2-5.2" />
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

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Picker / settings pills                                             */
/* ------------------------------------------------------------------ */

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

export function AgentIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props}>
      <rect x="3" y="5" width="10" height="8" rx="2" />
      <path d="M8 2.4V5M5.8 8.4h.1M10.1 8.4h.1M6.2 10.8h3.6" />
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

/* ------------------------------------------------------------------ */
/* Welcome suggestions                                                 */
/* ------------------------------------------------------------------ */

export function BookIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M2.8 12.6V2.9a1.2 1.2 0 0 1 1.2-1.2h8.9v10.6H4a1.2 1.2 0 0 0-1.2 1.2z" />
      <path d="M2.8 12.6a1.2 1.2 0 0 1 1.2-1.2h8.9" />
      <path d="M5.4 4.4h5M5.4 6.8h3.4" />
    </IconBase>
  );
}

export function BugIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M5.6 5.4V4.8a2.4 2.4 0 0 1 4.8 0v.6" />
      <path d="M4.6 6.4h6.8v3.4a3.4 3.4 0 0 1-6.8 0z" />
      <path d="M4.6 8H2.2M4.8 10.4 2.6 12M11.4 8h2.4M11.2 10.4l2.2 1.6M8 10v3.6" />
    </IconBase>
  );
}

export function FlaskIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M6.2 1.8v3.4L3 12.1a1.2 1.2 0 0 0 1 1.9h8a1.2 1.2 0 0 0 1-1.9L9.8 5.2V1.8" />
      <path d="M6.2 1.8h3.6" />
      <path d="M4.4 9.6h7.2" />
    </IconBase>
  );
}

export function PulseIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M1.5 8h2.4l1.2-3.5 1.9 7 1.7-5.2 1.1 1.7h3.7" />
    </IconBase>
  );
}

/* ------------------------------------------------------------------ */
/* Capability surfaces                                                 */
/* ------------------------------------------------------------------ */

export function SlashIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M9.4 2.6 6.6 13.4" />
      <path d="M2.8 5.6 4.6 8l-1.8 2.4M13.2 5.6 11.4 8l1.8 2.4" />
    </IconBase>
  );
}

export function PencilIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M11.4 2.6a1.6 1.6 0 0 1 2.3 2.3l-7.6 7.6-3 .7.7-3z" />
      <path d="M10.2 3.8 12.5 6.1" />
    </IconBase>
  );
}

export function ForkIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props}>
      <circle cx="4.4" cy="3.4" r="1.6" />
      <circle cx="4.4" cy="12.6" r="1.6" />
      <circle cx="11.6" cy="3.4" r="1.6" />
      <path d="M4.4 5v6" />
      <path d="M11.6 5v1.4a3 3 0 0 1-3 3H6.2" />
    </IconBase>
  );
}

export function GaugeIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M2.2 11.4a6.2 6.2 0 1 1 11.6 0" />
      <path d="M8 8.6 10.7 5.8" />
      <circle cx="8" cy="9.2" r="1" />
    </IconBase>
  );
}

export function ImageIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props}>
      <rect x="2.2" y="3" width="11.6" height="10" rx="1.6" />
      <circle cx="5.9" cy="6.4" r="1.05" />
      <path d="m3.4 11.6 3.2-3.1 2.3 2.2 1.9-1.9 1.8 1.8" />
    </IconBase>
  );
}

export function PlanIcon(props: IconProps): JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M5.8 4.2h7.6M5.8 8h7.6M5.8 11.8h7.6" />
      <path d="m1.9 4.1 1 1 1.5-1.9M1.9 11.7l1 1 1.5-1.9" />
      <path d="M2.6 7.4h1.2" />
    </IconBase>
  );
}
