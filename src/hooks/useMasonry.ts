import { useEffect } from 'react';

/** Height of one grid row and the space kept under each card, from `.grid` in styles.css. */
export function gridRowMetrics(grid: HTMLElement): { unit: number; gap: number } {
  const style = getComputedStyle(grid);
  return {
    unit: parseFloat(style.getPropertyValue('--row-unit')) || 8,
    gap: parseFloat(style.getPropertyValue('--row-gap')) || 16,
  };
}

/**
 * Stacks the grid's cards like a masonry board: the grid has short rows, and
 * each card spans as many as its height needs, so a short card no longer
 * leaves a gap under it the height of the tallest card in its row. Cards are
 * still placed in order, left to right, each in the first spot that fits.
 * Spans are set directly on the elements as they resize, without re-rendering.
 */
export function useMasonry(grid: HTMLElement | null) {
  useEffect(() => {
    if (!grid || typeof ResizeObserver === 'undefined') return;
    const place = (el: Element) => {
      if (!(el instanceof HTMLElement)) return;
      const { unit, gap } = gridRowMetrics(grid);
      const height = el.getBoundingClientRect().height;
      el.style.gridRowEnd = `span ${Math.max(1, Math.ceil((height + gap) / unit))}`;
    };
    const observer = new ResizeObserver((entries) => entries.forEach((entry) => place(entry.target)));
    for (const el of grid.children) observer.observe(el);
    const children = new MutationObserver((records) => {
      for (const record of records) {
        record.addedNodes.forEach((node) => node instanceof Element && observer.observe(node));
        record.removedNodes.forEach((node) => node instanceof Element && observer.unobserve(node));
      }
    });
    children.observe(grid, { childList: true });
    return () => {
      observer.disconnect();
      children.disconnect();
    };
  }, [grid]);
}
