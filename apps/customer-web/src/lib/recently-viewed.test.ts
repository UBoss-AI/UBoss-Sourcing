import { beforeEach, describe, expect, it } from 'vitest';
import { readRecentlyViewed, recordViewed } from './recently-viewed';

beforeEach(() => {
  window.localStorage.clear();
});

describe('recently viewed', () => {
  it('keeps the newest first, once each, and at most eight', () => {
    for (let index = 0; index < 10; index += 1) recordViewed({ kind: 'product', slug: `p${String(index)}`, name: `P${String(index)}` });
    recordViewed({ kind: 'product', slug: 'p3', name: 'P3' });
    const list = readRecentlyViewed();
    expect(list).toHaveLength(8);
    expect(list[0]?.slug).toBe('p3');
    expect(list.filter((item) => item.slug === 'p3')).toHaveLength(1);
  });

  it('reads an unreadable store as empty', () => {
    window.localStorage.setItem('recently-viewed.v1', '{not json');
    expect(readRecentlyViewed()).toEqual([]);
  });
});
