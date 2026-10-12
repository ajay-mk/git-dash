import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useWindowDrag } from './useWindowDrag';
import { MAX_CARD_ROWS, MAX_CARD_SPAN, MAX_ITEMS, MIN_CARD_ROWS, MIN_ITEMS, type WidgetType } from '../config/schema';
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
  /** The card's lists folded at this size. */
  collapsed: WidgetType[];
}

/** A list on a card, in the order the card shows them. */
export interface CardSection {
  type: WidgetType;
  collapsed: boolean;
  /** Entries the list may show when open. */
  limit: number;
  /** Entries it shows when open, which may be fewer (an empty list counts as one, for its message). */
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
  /** Height of the card with every list folded, the smallest it can be. */
  base: number;
  minRows: number;
  sections: readonly CardSection[];
  columns: number;
}

/** Fallback height of one list entry, for when it cannot be measured. */
const ROW_HEIGHT = 28;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Grid rows a card of `height` pixels spans, within the saved range and no less than `min`. */
function rowsFor(height: number, unit: number, gap: number, min = MIN_CARD_ROWS): number {
  return clamp(Math.round((height + gap) / unit), Math.max(min, MIN_CARD_ROWS), MAX_CARD_ROWS);
}

/**
 * Which lists stay open, and how many entries each gains or loses, when a
 * card is resized by `grown` pixels to `height`. Growing opens folded lists
 * first, top down, as soon as there is room for an entry, then adds entries.
 * Shrinking removes entries, then folds lists from the bottom up once there
 * is no room left for one entry in each; `base` is the card's height with
 * every list folded and `entry` the height of one entry.
 */
export function planResize(
  sections: readonly CardSection[],
  grown: number,
  height: number,
  base: number,
  entry: number,
): { collapsed: WidgetType[]; delta: number } {
  const open = sections.filter((s) => !s.collapsed);
  let room = grown;
  let kept: CardSection[];
  if (grown >= 0) {
    kept = [...open];
    for (const s of sections) {
      if (!s.collapsed) continue;
      if (room < entry) break;
      kept.push(s);
      room -= entry * s.rows;
    }
  } else {
    // Room for one entry in each list that stays open.
    const fits = Math.max(0, Math.floor((height - base) / entry + 1e-6));
    kept = open.slice(0, fits);
  }
  return {
    collapsed: sections.filter((s) => !kept.includes(s)).map((s) => s.type),
    delta: grown >= 0 && room <= 0 ? 0 : spread(kept.map((s) => s.limit), room / entry),
  };
}

/**
 * The change to every limit in `limits` that adds (or removes) closest to
 * `entries` entries in all, as each one stops at MIN_ITEMS and MAX_ITEMS.
 */
function spread(limits: readonly number[], entries: number): number {
  const step = Math.sign(entries);
  const moved = (d: number) => limits.reduce((n, l) => n + Math.abs(clamp(l + d, MIN_ITEMS, MAX_ITEMS) - l), 0);
  let best = 0;
  for (let d = step; step !== 0 && Math.abs(d) <= MAX_ITEMS; d += step) {
    const now = moved(d);
    if (now === moved(d - step)) break;
    if (Math.abs(now - Math.abs(entries)) < Math.abs(moved(best) - Math.abs(entries))) best = d;
  }
  return best;
}

const sameTypes = (a: readonly WidgetType[], b: readonly WidgetType[]) =>
  a.length === b.length && a.every((t) => b.includes(t));

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
 * removes list entries to match. Shrinking a card past one entry per list
 * folds its lists, down to just their headers, and growing it opens them
 * again (see `planResize`). The keyboard does the same with the arrow
 * keys on the grip, and Delete (or a double click) lets the card fit its
 * content again. Like reordering, a drag only commits when it ends (Escape
 * cancels), because changing the entry count refetches the card.
 */
export function useCardResize({ grid, onSpan, onHeight, onFold, onRows, describe }: {
  /** The grid that holds the cards. */
  grid: HTMLElement | null;
  onSpan: (id: string, span: number) => void;
  /** Sets a card's height in grid rows, or lets it fit its content with null. */
  onHeight: (id: string, rows: number | null) => void;
  /** Sets which of a card's lists are folded. */
  onFold: (id: string, collapsed: WidgetType[]) => void;
  /**
   * Adds `delta` entries to the card's lists, except the `collapsed` ones.
   * Returns whether any list actually changed (they may be at their limit).
   */
  onRows: (id: string, delta: number, collapsed: WidgetType[]) => boolean;
  /** Describes a card's size after a change, for the live announcement. */
  describe: (id: string, span: number, delta: number, collapsed: WidgetType[]) => string;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [announcement, setAnnouncement] = useState('');
  // Tracks the grid lays out; cards span at most MAX_CARD_SPAN of them.
  const [tracks, setTracks] = useState(MAX_CARD_SPAN);
  const columns = Math.min(tracks, MAX_CARD_SPAN);
  const dragRef = useRef<Drag | null>(null);
  const callbacks = useRef({ onSpan, onHeight, onFold, onRows, describe });
  useEffect(() => {
    callbacks.current = { onSpan, onHeight, onFold, onRows, describe };
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
      const { id, span, delta, rows, collapsed, startSpan, startRows, sections } = current;
      const folded = !sameTypes(collapsed, sections.filter((s) => s.collapsed).map((s) => s.type));
      if (span === startSpan && rows === startRows && !folded) return;
      const { onSpan, onHeight, onFold, onRows, describe } = callbacks.current;
      if (span !== startSpan) onSpan(id, span);
      if (rows !== startRows) onHeight(id, rows);
      if (folded) onFold(id, collapsed);
      const changed = delta !== 0 && onRows(id, delta, collapsed);
      setAnnouncement(describe(id, span, changed ? delta : 0, collapsed));
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
      const rows = rowsFor(d.height + dy, d.unit, d.rowGap, d.minRows);
      const { collapsed, delta } = planResize(
        d.sections,
        (rows - d.startRows) * d.unit,
        rows * d.unit - d.rowGap,
        d.base,
        d.row,
      );
      if (span !== d.span || delta !== d.delta || rows !== d.rows || !sameTypes(collapsed, d.collapsed)) {
        setDragState({ ...d, span, delta, rows, collapsed });
      }
    },
    finish,
  );

  /** Where a resize of `card` starts from. */
  const measure = (card: HTMLElement, gridEl: HTMLElement, span: number) => {
    const rect = card.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(gridEl).columnGap) || 0;
    const { unit, gap: rowGap } = gridRowMetrics(gridEl);
    // The card's height with just its content showing (a sized card may
    // scroll, or stretch its body past the content), less the bodies of its
    // open lists: what is left are the header and the folded lists' headers.
    let content = rect.height;
    const body = card.querySelector<HTMLElement>('.card-body');
    const last = body?.lastElementChild;
    if (body && last) {
      const box = body.getBoundingClientRect();
      const inner =
        last.getBoundingClientRect().bottom -
        box.top +
        body.scrollTop +
        (parseFloat(getComputedStyle(last).marginBottom) || 0) +
        (parseFloat(getComputedStyle(body).paddingBottom) || 0);
      if (Number.isFinite(inner)) content = rect.height - box.height + inner;
    }
    const bodies = new Map<string, number>();
    for (const section of card.querySelectorAll<HTMLElement>('[data-section]')) {
      const height = section.lastElementChild?.getBoundingClientRect().height ?? 0;
      bodies.set(section.dataset.section ?? '', height);
    }
    const folded = content - [...bodies.values()].reduce((a, b) => a + b, 0);
    return {
      // Until its lists load there is nothing to fold, and the card stops at its content.
      base: bodies.size > 0 ? folded : -Infinity,
      bodies,
      minRows: Math.ceil((folded + rowGap) / unit),
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
   * `sections` the lists on it, which new entries are spread across.
   */
  const gripProps = (id: string, label: string, span: number, sections: readonly CardSection[]) => ({
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
        collapsed: sections.filter((s) => s.collapsed).map((s) => s.type),
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startSpan: span,
        sections,
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
      const open = sections.filter((s) => !s.collapsed);
      const folded = sections.filter((s) => s.collapsed);
      let collapsed = folded.map((s) => s.type);
      // Up folds the bottom list once every open list is down to one entry;
      // down opens folded lists, top first, before adding entries.
      let fold: CardSection | undefined;
      if (delta < 0 && open.length > 0 && open.every((s) => s.limit <= MIN_ITEMS)) {
        fold = open[open.length - 1]!;
        collapsed = [...collapsed, fold.type];
      } else if (delta > 0 && folded.length > 0) {
        fold = folded[0]!;
        collapsed = collapsed.filter((t) => t !== fold!.type);
      }
      let resized = false;
      if (delta !== 0 && card && grid) {
        const m = measure(card, grid, span);
        // One step is one entry in each open list, or the list folded or opened.
        const step = !fold
          ? m.row * Math.max(1, open.length)
          : delta < 0
            ? (m.bodies.get(fold.type) ?? m.row)
            : m.row * fold.rows;
        const rows = rowsFor(m.height + delta * step, m.unit, m.rowGap, delta < 0 ? m.minRows : undefined);
        resized = rows !== m.startRows;
        if (resized) onHeight(id, rows);
      }
      if (fold) onFold(id, collapsed);
      const changed = delta !== 0 && !fold && onRows(id, delta, collapsed);
      if (nextSpan !== span || resized || fold || changed) {
        setAnnouncement(describe(id, nextSpan, changed ? delta : 0, collapsed));
      }
    },
  });

  return {
    /** Columns in the grid; spans are clamped to it. */
    columns,
    /** The resize in progress, if any. */
    resizing: drag && { id: drag.id, span: drag.span, delta: drag.delta, rows: drag.rows, collapsed: drag.collapsed },
    announcement,
    gripProps,
  };
}
