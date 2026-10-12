import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WidgetType } from '../config/schema';
import { planResize, useCardResize, type CardSection } from './useCardResize';

const sections = (collapsed: WidgetType[] = [], limit = 2): CardSection[] =>
  (['pullRequests', 'issues'] as const).map((type) => ({ type, limit, rows: limit, collapsed: collapsed.includes(type) }));

describe('planResize', () => {
  // A card 120px tall with both lists folded, and 28px entries.
  const plan = (s: CardSection[], grown: number, height: number) => planResize(s, grown, height, 120, 28);

  it('removes entries before folding the lists, from the bottom up', () => {
    expect(plan(sections(), -56, 176)).toEqual({ collapsed: [], delta: -1 });
    expect(plan(sections(), -80, 152)).toEqual({ collapsed: ['issues'], delta: -1 });
    expect(plan(sections(), -112, 120)).toEqual({ collapsed: ['pullRequests', 'issues'], delta: 0 });
  });

  it('opens folded lists from the top down before adding entries', () => {
    const folded = sections(['pullRequests', 'issues']);
    expect(plan(folded, 20, 140)).toEqual({ collapsed: ['pullRequests', 'issues'], delta: 0 });
    // Pull requests open once there is room for both of their entries.
    expect(plan(folded, 32, 152)).toEqual({ collapsed: ['pullRequests', 'issues'], delta: 0 });
    expect(plan(folded, 60, 180)).toEqual({ collapsed: ['issues'], delta: 0 });
    expect(plan(folded, 120, 240)).toEqual({ collapsed: [], delta: 0 });
    // Two entries for each list, then one more each.
    expect(plan(folded, 168, 288)).toEqual({ collapsed: [], delta: 1 });
  });

  it('spreads entries over lists with different limits, each stopping at one', () => {
    const uneven: CardSection[] = [
      { type: 'pullRequests', limit: 5, rows: 5, collapsed: false },
      { type: 'issues', limit: 1, rows: 1, collapsed: false },
    ];
    expect(plan(uneven, -112, 400)).toEqual({ collapsed: [], delta: -4 });
  });

  it('opens a folded list by the entries it shows, not its limit', () => {
    const few: CardSection[] = [{ type: 'pullRequests', limit: 10, rows: 1, collapsed: true }];
    expect(plan(few, 56, 176)).toEqual({ collapsed: [], delta: 1 });
  });

  it('counts the entries a folded list gave back before removing any from the others', () => {
    const few = sections([], 10).map((s) => ({ ...s, rows: 1 }));
    // 168px leaves room for one list, and folding Issues frees the one row asked for.
    expect(plan(few, -28, 168)).toEqual({ collapsed: ['issues'], delta: 0 });
  });

  it('leaves lists the user folded alone while shrinking', () => {
    expect(plan(sections(['pullRequests']), -28, 200)).toEqual({ collapsed: ['pullRequests'], delta: -1 });
  });

  it('leaves the lists alone when the height does not change', () => {
    expect(plan(sections(['issues']), 0, 400)).toEqual({ collapsed: ['issues'], delta: 0 });
  });

  it('opens folded lists into space the card already has', () => {
    // A 400px card with Issues folded and two pull requests showing: room to spare.
    expect(plan(sections(['issues']), 8, 400)).toEqual({ collapsed: [], delta: 0 });
  });

  it('does not fold or open anything when the lists were not measured', () => {
    expect(planResize(sections(), -400, 50, -Infinity, 28)).toEqual({ collapsed: [], delta: -1 });
    expect(planResize(sections(['issues']), 400, 600, -Infinity, 28)).toEqual({ collapsed: ['issues'], delta: 14 });
  });
});

/** A card whose header and folded lists are 120px tall, each entry 28px. */
function Card({ onFold, onRows, onHeight, limit = 2, rows = limit }: {
  onFold: (collapsed: WidgetType[]) => void;
  onRows: (delta: number, collapsed: WidgetType[]) => void;
  onHeight: (rows: number | null) => void;
  limit?: number;
  /** Entries each list shows, which may be fewer than its limit. */
  rows?: number;
}) {
  const [grid, setGrid] = useState<HTMLElement | null>(null);
  const [collapsed, setCollapsed] = useState<WidgetType[]>([]);
  const resize = useCardResize({
    grid,
    onSpan: () => {},
    onHeight: (_, rows) => onHeight(rows),
    onFold: (_, next) => {
      setCollapsed(next);
      onFold(next);
    },
    onRows: (_, delta, next) => {
      onRows(delta, next);
      return true;
    },
    describe: () => '',
  });
  const shown = resize.resizing?.collapsed ?? collapsed;
  const open = sections(collapsed).filter((s) => !s.collapsed).length;
  return (
    <div ref={setGrid} className="grid" style={{ '--row-unit': '8px', '--row-gap': '16px' } as React.CSSProperties}>
      <article data-height={120 + open * 56}>
        <div className="card-body">
          {sections(shown).map((s) => (
            <section key={s.type} data-section={s.type} data-folded={s.collapsed}>
              <div className="section-header">{s.type}</div>
              <div data-height={collapsed.includes(s.type) ? 0 : 56}>
                <ul className="rows">
                  <li data-height={28} />
                </ul>
              </div>
            </section>
          ))}
        </div>
        <button type="button" {...resize.gripProps('card', 'card', 1, sections(collapsed, limit).map((s) => ({ ...s, rows })))} />
      </article>
    </div>
  );
}

describe('useCardResize', () => {
  afterEach(() => vi.restoreAllMocks());

  it('folds lists while shrinking a card down to their headers, and opens them while growing it', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { width: 300, height: Number(this.dataset.height ?? 0) } as DOMRect;
    });
    const onFold = vi.fn();
    const onRows = vi.fn();
    const onHeight = vi.fn();
    const { container } = render(<Card onFold={onFold} onRows={onRows} onHeight={onHeight} />);
    const grip = screen.getByRole('button', { name: 'Resize card' });
    const folded = () => [...container.querySelectorAll('[data-folded="true"]')].map((s) => s.getAttribute('data-section'));

    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 0, clientY: -80 });
    expect(folded()).toEqual(['issues']);
    // Well past the headers: the card stops there, with both lists folded.
    fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 0, clientY: -400 });
    expect(folded()).toEqual(['pullRequests', 'issues']);
    expect(onFold).not.toHaveBeenCalled();
    fireEvent.pointerUp(window, { pointerId: 1 });
    // 120px of headers, plus the 16px under the card, in 8px rows.
    expect(onHeight).toHaveBeenLastCalledWith(17);
    expect(onFold).toHaveBeenLastCalledWith(['pullRequests', 'issues']);
    expect(onRows).not.toHaveBeenCalled();

    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 0, clientY: 64 });
    expect(folded()).toEqual(['issues']);
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(onFold).toHaveBeenLastCalledWith(['issues']);
  });

  it('removes entries with the up arrow before folding anything', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { width: 300, height: Number(this.dataset.height ?? 0) } as DOMRect;
    });
    const onFold = vi.fn();
    const onRows = vi.fn();
    render(<Card onFold={onFold} onRows={onRows} onHeight={() => {}} />);
    const grip = screen.getByRole('button', { name: 'Resize card' });
    // Two entries in each list: up removes one from each first.
    fireEvent.keyDown(grip, { key: 'ArrowUp' });
    expect(onRows).toHaveBeenLastCalledWith(-1, []);
    expect(onFold).not.toHaveBeenCalled();
  });

  it('folds the bottom list with the up arrow at one entry, and opens the top one first with down', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { width: 300, height: Number(this.dataset.height ?? 0) } as DOMRect;
    });
    const onFold = vi.fn();
    const onRows = vi.fn();
    render(<Card onFold={onFold} onRows={onRows} onHeight={() => {}} limit={1} />);
    const grip = screen.getByRole('button', { name: 'Resize card' });
    fireEvent.keyDown(grip, { key: 'ArrowUp' });
    expect(onFold).toHaveBeenLastCalledWith(['issues']);
    fireEvent.keyDown(grip, { key: 'ArrowUp' });
    expect(onFold).toHaveBeenLastCalledWith(['issues', 'pullRequests']);
    fireEvent.keyDown(grip, { key: 'ArrowDown' });
    expect(onFold).toHaveBeenLastCalledWith(['issues']);
    expect(onRows).not.toHaveBeenCalled();
  });

  it('folds with the up arrow once the lists show one entry, whatever their limit', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { width: 300, height: Number(this.dataset.height ?? 0) } as DOMRect;
    });
    const onFold = vi.fn();
    render(<Card onFold={onFold} onRows={() => {}} onHeight={() => {}} limit={10} rows={1} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Resize card' }), { key: 'ArrowUp' });
    expect(onFold).toHaveBeenLastCalledWith(['issues']);
  });
});
