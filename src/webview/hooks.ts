/**
 * Shared webview hooks.
 */

import { useEffect, useRef } from 'preact/hooks';

/**
 * Closes a popup on an outside pointer press or Escape.
 *
 * `rootRef` must contain both the trigger and the popup so pressing the trigger
 * is handled by the trigger itself instead of closing the popup first.
 * Escape stops propagating so the App-level approval shortcut does not fire.
 */
export function useDismiss(
  open: boolean,
  rootRef: { current: HTMLElement | null },
  close: () => void,
): void {
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const root = rootRef.current;
      const target = event.target;
      if (root && target instanceof Node && !root.contains(target)) closeRef.current();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, rootRef]);
}
