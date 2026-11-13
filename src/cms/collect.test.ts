import { describe, expect, it } from 'vitest';

import { collectItemRefs, collectLayoutItemIds, type PageLayoutContent } from './index';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('collectItemRefs', () => {
  it('finds markers at any depth, in lists and objects, once each, in order of first appearance', () => {
    const content = { a: { $ref: id(2) }, list: [{ deep: { $ref: id(1) } }, { $ref: id(2) }], text: 'x', n: 1, nothing: null };
    expect(collectItemRefs(content)).toEqual([id(2), id(1)]);
  });

  it('returns nothing for content without markers or with non-string markers', () => {
    expect(collectItemRefs({ a: 1, b: [null, 'x'] })).toEqual([]);
    expect(collectItemRefs({ $ref: 5 })).toEqual([]);
    expect(collectItemRefs(null)).toEqual([]);
    expect(collectItemRefs('text')).toEqual([]);
  });

  it('does not search inside a marker', () => {
    expect(collectItemRefs({ $ref: id(1), nested: { $ref: id(2) } })).toEqual([id(1)]);
  });
});

describe('collectLayoutItemIds', () => {
  it('lists every slot item once, in page order', () => {
    const content: PageLayoutContent = {
      sections: [
        { key: 'a', template: 't', slots: { one: [id(3), id(1)], two: [id(2)] } },
        { key: 'b', template: 't', slots: { one: [id(1), id(4)] } },
        { key: 'c', template: 't', slots: {} },
      ],
    };
    expect(collectLayoutItemIds(content)).toEqual([id(3), id(1), id(2), id(4)]);
    expect(collectLayoutItemIds({ sections: [] })).toEqual([]);
  });
});
