import { describe, expect, it } from 'vitest';
import { moveItem } from './useReorder';

describe('moveItem', () => {
  it.each([
    [0, 2, ['b', 'c', 'a', 'd']],
    [3, 0, ['d', 'a', 'b', 'c']],
    [1, 1, ['a', 'b', 'c', 'd']],
    [2, 3, ['a', 'b', 'd', 'c']],
  ])('moves index %i to %i', (from, to, expected) => {
    expect(moveItem(['a', 'b', 'c', 'd'], from, to)).toEqual(expected);
  });

  it('does not change the input', () => {
    const list = ['a', 'b'];
    moveItem(list, 0, 1);
    expect(list).toEqual(['a', 'b']);
  });
});
