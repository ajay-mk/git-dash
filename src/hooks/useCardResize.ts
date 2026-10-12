import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { MAX_CARD_SPAN, MAX_ITEMS } from '../config/schema';

/** A resize in progress, as previewed on the card. */
export interface CardResize {
  id: string;
  /** Width in grid columns. */
  span: number;
  /** Entries added to (or removed from) each list on the card. */
  delta: number;
  /** Keeps the card as tall as the pointer while it grows, before the new entries load. */
  minHeight: number | undefined;
}

interface Drag extends CardResize {
  pointerId: number;
  startX: number;
  startY: number;
  startSpan: number;
  width: number;
  height: number;
  column: number;
  gap: number;
  row: number;
  lists: number;
  columns: number;
}

/** Fallback height of one list entry, for when it cannot be measured. */
const ROW_HEIGHT = 28;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Number of columns a grid lays out, or null when the browser does not resolve them. */
function gridColumns(grid: HTMLElement): number | null {
  const tracks = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean);
  return tracks.length > 0 && tracks.every((t) => t.endsWith('px')) ? tracks.length : null;
}

/**
 * Lets the user resize repo cards from a grip in the corner: dragging
 * sideways snaps the width to whole grid columns, dragging down or up adds or
 * removes list entries. The keyboard does the same with the arrow keys on the
 * grip. Like reordering, a drag only commits when it ends (Escape cancels),
 * because changing the entry count refetches the card.
 */
export function useCardResize({ onSpan, onRows, describe }: {
  onSpan: (id: string, span: number) => void;
  onRows: (id: string, delta: number) => void;
  /** Describes a card's size after a change, for the live announcement. */
  describe: (id: string, span: number, delta: number) => string;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [columns, setColumns] = useState(MAX_CARD_SPAN);
  const [grid, setGrid] = useState<HTMLElement | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const callbacks = useRef({ onSpan, onRows, describe });
  useEffect(() => {
    callbacks.current = { onSpan, onRows, describe };
  });

  // Cards cannot be wider than the grid, so track how many columns it has.
  useEffect(() => {
    if (!grid) return;
    const measure = () => setColumns(gridColumns(grid) ?? MAX_CARD_SPAN);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [grid]);

  const setDragState = useCallback((next: Drag | null) => {
    dragRef.current = next;
    setDrag(next);
  }, []);

  const finish = useCallback(
    (commit: boolean) => {
      const current = dragRef.current;
      if (!current) return;
      setDragState(null);
      if (!commit) return setAnnouncement('Resizing cancelled.');
      const { id, span, delta, startSpan } = current;
      if (span === startSpan && delta === 0) return;
      if (span !== startSpan) callbacks.current.onSpan(id, span);
      if (delta !== 0) callbacks.current.onRows(id, delta);
      setAnnouncement(callbacks.current.describe(id, span, delta));
    },
    [setDragState],
  );

  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: globalThis.PointerEvent) => {
      const d = dragRef.current;
      if (!d || d.pointerId !== e.pointerId) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      const span = clamp(Math.round((d.width + dx + d.gap) / (d.column + d.gap)), 1, d.columns);
      const delta = clamp(Math.round(dy / (d.row * d.lists)), -MAX_ITEMS, MAX_ITEMS);
      const minHeight = dy > 0 ? d.height + dy : undefined;
      if (span !== d.span || delta !== d.delta || minHeight !== d.minHeight) {
        setDragState({ ...d, span, delta, minHeight });
      }
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

  /**
   * Props for a card's resize grip. `span` is the card's current width and
   * `lists` the number of open list widgets on it, which the height spreads
   * new entries across.
   */
  const gripProps = (id: string, label: string, span: number, lists: number) => ({
    'aria-label': `Resize ${label}`,
    'aria-describedby': 'resize-help',
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || dragRef.current) return;
      const card = e.currentTarget.closest('article');
      if (!card || !grid) return;
      e.preventDefault();
      e.currentTarget.focus();
      const rect = card.getBoundingClientRect();
      const gap = parseFloat(getComputedStyle(grid).columnGap) || 0;
      const column = (grid.clientWidth - gap * (columns - 1)) / columns || rect.width / span || 1;
      const row = card.querySelector('.rows > li')?.getBoundingClientRect().height || ROW_HEIGHT;
      setDragState({
        id,
        span,
        delta: 0,
        minHeight: undefined,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startSpan: span,
        width: rect.width,
        height: rect.height,
        column,
        gap,
        row,
        lists: Math.max(1, lists),
        columns,
      });
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (dragRef.current) return;
      let nextSpan = span;
      let delta = 0;
      switch (e.key) {
        case 'ArrowLeft':
          nextSpan = span - 1;
          break;
        case 'ArrowRight':
          nextSpan = span + 1;
          break;
        case 'ArrowUp':
          delta = -1;
          break;
        case 'ArrowDown':
          delta = 1;
          break;
        default:
          return;
      }
      e.preventDefault();
      nextSpan = clamp(nextSpan, 1, columns);
      if (nextSpan !== span) onSpan(id, nextSpan);
      if (delta !== 0) onRows(id, delta);
      if (nextSpan !== span || delta !== 0) setAnnouncement(describe(id, nextSpan, delta));
    },
  });

  return {
    /** Pass as the `ref` of the grid that holds the cards. */
    bindGrid: setGrid,
    /** Columns in the grid; spans are clamped to it. */
    columns,
    /** The resize in progress, if any. */
    resizing: drag && { id: drag.id, span: drag.span, delta: drag.delta, minHeight: drag.minHeight },
    announcement,
    gripProps,
  };
}
