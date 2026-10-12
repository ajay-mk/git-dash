import { render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMasonry } from './useMasonry';

function Grid({ heights }: { heights: number[] }) {
  const [grid, setGrid] = useState<HTMLElement | null>(null);
  useMasonry(grid);
  return (
    <div ref={setGrid} className="grid" style={{ '--row-unit': '8px', '--row-gap': '16px' } as React.CSSProperties}>
      {heights.map((h, i) => (
        <article key={i} data-height={h} />
      ))}
    </div>
  );
}

describe('useMasonry', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('spans each card over the grid rows its height needs, plus the gap under it', () => {
    let notify: (entries: { target: Element }[]) => void = () => {};
    const observed: Element[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: typeof notify) {
          notify = cb;
        }
        observe(el: Element) {
          observed.push(el);
        }
        unobserve() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { height: Number(this.dataset.height ?? 0) } as DOMRect;
    });

    const { container } = render(<Grid heights={[100, 300]} />);
    const cards = [...container.querySelectorAll('article')];
    expect(observed).toEqual(cards);

    notify(cards.map((target) => ({ target })));
    // ceil((100 + 16) / 8) and ceil((300 + 16) / 8)
    expect(cards.map((c) => c.style.gridRowEnd)).toEqual(['span 15', 'span 40']);
  });
});
