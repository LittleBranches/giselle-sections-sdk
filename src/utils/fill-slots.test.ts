import { describe, expect, it } from 'vitest';

import { fillSlots } from './fill-slots';

describe('fillSlots', () => {
  it('puts each named value into its {slot}', () => {
    expect(fillSlots('{finished} / {total} done', { finished: 2, total: 5 })).toBe('2 / 5 done');
  });

  it('accepts strings and numbers, and fills a slot that appears more than once', () => {
    expect(fillSlots('{name}, {name} and {count}', { name: 'Ada', count: 3 })).toBe('Ada, Ada and 3');
  });

  it('leaves a slot with no value as it is, so a missing value shows up instead of vanishing', () => {
    expect(fillSlots('Hello {name}, you have {count}', { name: 'Ada' })).toBe('Hello Ada, you have {count}');
  });

  it('returns text without slots unchanged', () => {
    expect(fillSlots('No slots here', { name: 'Ada' })).toBe('No slots here');
    expect(fillSlots('', {})).toBe('');
  });

  it('puts a value in as plain text, even one that looks like a replacement pattern', () => {
    expect(fillSlots('Price: {price}', { price: '$& and $1' })).toBe('Price: $& and $1');
  });

  it('does not fill a slot from inside a value it just inserted', () => {
    expect(fillSlots('{a} {b}', { a: '{b}', b: 'x' })).toBe('{b} x');
  });
});
