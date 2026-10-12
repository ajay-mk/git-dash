import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useWindowDrag } from './useWindowDrag';
import { MAX_CARD_ROWS, MAX_CARD_SPAN, MAX_ITEMS, MIN_CARD_ROWS } from '../config/schema';
import { gridRowMetrics } from './useMasonry';

/** A resize in progress, as previewed on the card. */
export interface CardResize {
  id: string;
  /** Width in grid columns. */
  span: number;
  /** Entries added to (or removed from) each list on the card. */
  delta: number;
  /** Height in grid rows. */
  rows: number;
}

interface Drag extends CardResize {
  pointerId: number;
  startX: number;
  startY: number;
  startSpan: number;
  startRows: number;
  width: number;
  height: number;
  column: number;
  gap: number;
  /** Grid row height and the space under each card. */
  unit: number;
  rowGap: number;
  row: number;
  lists: number;
  columns: number;
}

/** Fallback height of one list entry, for when it cannot be measured. */
const ROW_HEIGHT = 28;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Grid rows a card of `height` pixels spans, within the saved range. */
function rowsFor(height: number, unit: number, gap: number): number {
  return clamp(Math.round((height + gap) / unit), MIN_CARD_ROWS, MAX_CARD_ROWS);
}

/** Number of columns a grid lays out, or null when the browser does not resolve them. */
function gridColumns(grid: HTMLElement): number | null {
  // Worked out from the grid's width and its `--card-min` track size, as
  // auto-fill does. The resolved track list cannot be used: a wide card adds
  // implicit tracks to it, so it never shrinks below that card's span.
  const style = getComputedStyle(grid);
  const min = parseFloat(style.getPropertyValue('--card-min'));
  const gap = parseFloat(style.columnGap) || 0;
  if (!(min > 0) || !(grid.clientWidth > 0)) return null;
  return Math.max(1, Math.floor((grid.clientWidth + gap) / (min + gap)));
}

/**
 * Lets the user resize repo cards from a grip in the corner. Dragging
 * sideways snaps the width to whole grid columns; dragging down or up sets
 * the card's height in whole grid rows, whatever it holds, and adds or
 * removes list entries to match. The keyboard does the same with the arrow
 * keys on the grip, and Delete (or a double click) lets the card fit its
 * content again. Like reordering, a drag only commits when it ends (Escape
 * cancels), because changing the entry count refetches the card.
 */
export function useCardResize({ grid, onSpan, onHeight, onRows, describe }: {
  /** The grid that holds the cards. */
  grid: HTMLElement | null;
  onSpan: (id: string, span: number) => void;
  /** Sets a card's height in grid rows, or lets it fit its content with null. */
  onHeight: (id: string, rows: number | null) => void;
  /** Returns whether any list actually changed (they may be at their limit). */
  onRows: (id: string, delta: number) => boolean;
  /** Describes a card's size after a change, for the live announcement. */
  describe: (id: string, span: number, delta: number) => string;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [announcement, setAnnouncement] = useState('');
  // Tracks the grid lays out; cards span at most MAX_CARD_SPAN of them.
  const [tracks, setTracks] = useState(MAX_CARD_SPAN);
  const columns = Math.min(tracks, MAX_CARD_SPAN);
  const dragRef = useRef<Drag | null>(null);
  const callbacks = useRef({ onSpan, onHeight, onRows, describe });
  useEffect(() => {
    callbacks.current = { onSpan, onHeight, onRows, describe };
  });

  // Cards cannot be wider than the grid, so track how many columns it has.
  useEffect(() => {
    if (!grid) return;
    const measure = () => setTracks(gridColumns(grid) ?? MAX_CARD_SPAN);
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
      const { id, span, delta, rows, startSpan, startRows } = current;
      if (span === startSpan && rows === startRows) return;
      if (span !== startSpan) callbacks.current.onSpan(id, span);
      if (rows !== startRows) callbacks.current.onHeight(id, rows);
      const changed = delta !== 0 && callbacks.current.onRows(id, delta);
      setAnnouncement(callbacks.current.describe(id, span, changed ? delta : 0));
    },
    [setDragState],
  );

  const dragging = drag !== null;
  useWindowDrag(
    dragging,
    () => dragRef.current?.pointerId,
    (e) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      const span = clamp(Math.round((d.width + dx + d.gap) / (d.column + d.gap)), 1, d.columns);
      // The card snaps to whole grid rows as it follows the pointer.
      const rows = rowsFor(d.height + dy, d.unit, d.rowGap);
      const grown = (rows - d.startRows) * d.unit;
      const delta = clamp(Math.round(grown / (d.row * d.lists)), -MAX_ITEMS, MAX_ITEMS);
      if (span !== d.span || delta !== d.delta || rows !== d.rows) {
        setDragState({ ...d, span, delta, rows });
      }
    },
    finish,
  );

  /** Where a resize of `card` starts from. */
  const measure = (card: HTMLElement, gridEl: HTMLElement, span: number) => {
    const rect = card.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(gridEl).columnGap) || 0;
    const { unit, gap: rowGap } = gridRowMetrics(gridEl);
    return {
      width: rect.width,
      height: rect.height,
      gap,
      unit,
      rowGap,
      // One track's width, from every track the grid has (not just the ones a card may span).
      column: (gridEl.clientWidth - gap * (tracks - 1)) / tracks || rect.width / span || 1,
      row: card.querySelector('.rows > li')?.getBoundingClientRect().height || ROW_HEIGHT,
      startRows: rowsFor(rect.height, unit, rowGap),
    };
  };

  /**
   * Props for a card's resize grip. `span` is the card's current width and
   * `lists` the number of open list widgets on it, which new entries are
   * spread across.
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
      const m = measure(card, grid, span);
      setDragState({
        ...m,
        id,
        span,
        delta: 0,
        rows: m.startRows,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startSpan: span,
        lists: Math.max(1, lists),
        columns,
      });
    },
    onDoubleClick: () => {
      onHeight(id, null);
      setAnnouncement(`${label} fits its content.`);
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (dragRef.current) return;
      const card = e.currentTarget.closest('article');
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
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          onHeight(id, null);
          setAnnouncement(`${label} fits its content.`);
          return;
        default:
          return;
      }
      e.preventDefault();
      nextSpan = clamp(nextSpan, 1, columns);
      if (nextSpan !== span) onSpan(id, nextSpan);
      let resized = false;
      if (delta !== 0 && card && grid) {
        // One step is one entry in each open list.
        const m = measure(card, grid, span);
        const rows = rowsFor(m.height + delta * m.row * Math.max(1, lists), m.unit, m.rowGap);
        resized = rows !== m.startRows;
        if (resized) onHeight(id, rows);
      }
      const changed = delta !== 0 && onRows(id, delta);
      if (nextSpan !== span || resized || changed) setAnnouncement(describe(id, nextSpan, changed ? delta : 0));
    },
  });

  return {
    /** Columns in the grid; spans are clamped to it. */
    columns,
    /** The resize in progress, if any. */
    resizing: drag && { id: drag.id, span: drag.span, delta: drag.delta, rows: drag.rows },
    announcement,
    gripProps,
  };
}
