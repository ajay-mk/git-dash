import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

/** Returns a copy of `list` with the item at `from` moved to `to`. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}

/** Marks the element that a dragged item can be dropped onto. */
export const REORDER_ATTR = 'data-reorder-id';

interface Drag {
  id: string;
  pointerId: number;
  order: string[];
  /** The item last swapped with, ignored until the pointer moves elsewhere so two cards of different sizes do not keep trading places. */
  skip: string | null;
}

/**
 * Lets the user reorder a list by dragging a handle or with the arrow keys on
 * it. Pointer events are used instead of HTML5 drag and drop, which the
 * desktop webviews handle inconsistently (and Tauri intercepts for file drops). The new order is only committed on
 * drop, so a drag does not save or refetch anything until it ends; Escape
 * cancels it.
 */
export function useReorder(ids: readonly string[], onCommit: (ids: string[]) => void, label: (id: string) => string) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const dragRef = useRef<Drag | null>(null);
  const handles = useRef(new Map<string, HTMLElement>());
  const refocus = useRef<string | null>(null);
  const idsRef = useRef(ids);
  const commitRef = useRef(onCommit);
  const labelRef = useRef(label);
  useEffect(() => {
    idsRef.current = ids;
    commitRef.current = onCommit;
    labelRef.current = label;
  });

  const setDragState = useCallback((next: Drag | null) => {
    dragRef.current = next;
    setDrag(next);
  }, []);

  const finish = useCallback((commit: boolean) => {
    const current = dragRef.current;
    if (!current) return;
    setDragState(null);
    const before = idsRef.current;
    if (!commit) return setAnnouncement('Reordering cancelled.');
    const changed = current.order.length !== before.length || current.order.some((id, i) => id !== before[i]);
    if (!changed) return;
    commitRef.current(current.order);
    setAnnouncement(`Moved ${labelRef.current(current.id)} to position ${current.order.indexOf(current.id) + 1} of ${current.order.length}.`);
  }, [setDragState]);

  // While dragging, follow the pointer anywhere in the window. Listening on
  // the window rather than capturing the pointer on the handle keeps the drag
  // alive when React moves the dragged card (and its handle) in the DOM.
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: globalThis.PointerEvent) => {
      const current = dragRef.current;
      if (!current || current.pointerId !== e.pointerId) return;
      const over = document
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest(`[${REORDER_ATTR}]`)
        ?.getAttribute(REORDER_ATTR);
      if (!over || over === current.id || !current.order.includes(over)) {
        if (current.skip !== null) dragRef.current = { ...current, skip: null };
        return;
      }
      if (over === current.skip) return;
      const order = moveItem(current.order, current.order.indexOf(current.id), current.order.indexOf(over));
      setDragState({ ...current, order, skip: over });
    };
    const onUp = (e: globalThis.PointerEvent) => {
      if (dragRef.current?.pointerId === e.pointerId) finish(true);
    };
    const onCancel = () => finish(false);
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onCancel);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onCancel);
      window.removeEventListener('keydown', onKey);
    };
  }, [dragging, finish, setDragState]);

  // Moving an element in the DOM can drop its focus; keep it on the handle
  // that was just moved with the keyboard.
  useEffect(() => {
    const id = refocus.current;
    if (id === null) return;
    refocus.current = null;
    const el = handles.current.get(id);
    if (el && document.activeElement !== el) el.focus();
  });

  const handleProps = (id: string) => ({
    ref: (el: HTMLElement | null) => {
      if (el) handles.current.set(id, el);
      else handles.current.delete(id);
    },
    'aria-label': `Reorder ${label(id)}`,
    'aria-describedby': 'reorder-help',
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || dragRef.current) return;
      e.preventDefault();
      e.currentTarget.focus();
      setDragState({ id, pointerId: e.pointerId, order: [...idsRef.current], skip: null });
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (dragRef.current) return;
      const list = idsRef.current;
      const from = list.indexOf(id);
      if (from < 0) return;
      let to: number;
      switch (e.key) {
        case 'ArrowUp':
        case 'ArrowLeft':
          to = from - 1;
          break;
        case 'ArrowDown':
        case 'ArrowRight':
          to = from + 1;
          break;
        case 'Home':
          to = 0;
          break;
        case 'End':
          to = list.length - 1;
          break;
        default:
          return;
      }
      e.preventDefault();
      if (to < 0 || to >= list.length || to === from) return;
      refocus.current = id;
      onCommit(moveItem(list, from, to));
      setAnnouncement(`Moved ${label(id)} to position ${to + 1} of ${list.length}.`);
    },
  });

  return {
    /** The ids in display order, including a drag in progress. */
    order: drag?.order ?? ids,
    /** The id being dragged, if any. */
    dragging: drag?.id ?? null,
    /** Text for a polite live region describing the last move. */
    announcement,
    handleProps,
  };
}
