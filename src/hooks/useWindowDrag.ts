import { useEffect, useRef } from 'react';

/**
 * Follows a pointer drag anywhere in the window while `active`. Listening on
 * the window rather than capturing the pointer on the handle keeps the drag
 * alive when React moves the dragged element in the DOM. Only events from the
 * dragging pointer count. A release ends the drag with `finish(true)`; a
 * cancel, Escape or the window losing focus ends it with `finish(false)`. A
 * move with no button held means the button was released outside the window,
 * which counts as a release.
 */
export function useWindowDrag(
  active: boolean,
  pointerId: () => number | undefined,
  onMove: (e: PointerEvent) => void,
  finish: (commit: boolean) => void,
) {
  const handlers = useRef({ pointerId, onMove, finish });
  useEffect(() => {
    handlers.current = { pointerId, onMove, finish };
  });

  useEffect(() => {
    if (!active) return;
    const ours = (e: PointerEvent) => handlers.current.pointerId() === e.pointerId;
    const move = (e: PointerEvent) => {
      if (!ours(e)) return;
      if (e.buttons === 0) handlers.current.finish(true);
      else handlers.current.onMove(e);
    };
    const up = (e: PointerEvent) => {
      if (ours(e)) handlers.current.finish(true);
    };
    const cancel = (e: PointerEvent) => {
      if (ours(e)) handlers.current.finish(false);
    };
    const blur = () => handlers.current.finish(false);
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handlers.current.finish(false);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', blur);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', blur);
      window.removeEventListener('keydown', key);
    };
  }, [active]);
}
