import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ContentValidationError } from '../content/errors';
import { MAX_ITEMS_PER_SLOT, createContentTypeRegistry, itemRefSchema, type ContentTypeInput } from './index';

const block = (overrides: Partial<ContentTypeInput> = {}): ContentTypeInput => ({
  key: 'hero',
  label: 'Hero',
  kind: 'block',
  storage: 'document',
  translatable: true,
  schema: z.object({ title: z.string(), cards: z.array(z.object({ heading: z.string() })).optional() }),
  component: 'Hero',
  ...overrides,
});

const container = (slotOverrides: Record<string, unknown> = {}): ContentTypeInput => ({
  key: 'section',
  label: 'Section',
  kind: 'container',
  storage: 'document',
  translatable: false,
  schema: z.object({}),
  component: 'Section',
  slots: [{ key: 'body', label: 'Body', allowedTypeKeys: ['hero'], ...slotOverrides }] as never,
});

describe('createContentTypeRegistry', () => {
  it('stores a type with its defaults and finds it by key', () => {
    const registry = createContentTypeRegistry();
    const stored = registry.register(block());
    expect(stored.editor).toEqual({ overrides: {}, groups: [], custom: false });
    expect(registry.get('hero')).toBe(stored);
    expect(registry.require('hero')).toBe(stored);
    expect(registry.get('nope')).toBeUndefined();
    expect(() => registry.require('nope')).toThrow(/no content type "nope"/);
  });

  it('refuses an invalid definition with the problems listed', () => {
    const registry = createContentTypeRegistry();
    const error = (() => {
      try {
        registry.register(block({ key: 'Bad Key', kind: 'block', slots: [{ key: 'a', label: 'A', allowedTypeKeys: ['x'] }] as never }));
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(ContentValidationError);
    expect((error as ContentValidationError).issues.join('\n')).toMatch(/key/);
    expect((error as ContentValidationError).issues.join('\n')).toMatch(/block has no slots/);
  });

  it('refuses a duplicate key', () => {
    const registry = createContentTypeRegistry();
    registry.register(block());
    expect(() => registry.register(block({ label: 'Other' }))).toThrow(/already registered/);
    expect(registry.list()).toHaveLength(1);
  });

  it('lists in registration order, narrowed by kind and storage', () => {
    const registry = createContentTypeRegistry();
    registry.register(block());
    registry.register(container());
    registry.register(block({ key: 'post', label: 'Post', storage: 'collection', translatable: false, adapter: 'posts' }));
    expect(registry.list().map((t) => t.key)).toEqual(['hero', 'section', 'post']);
    expect(registry.list({ kind: 'container' }).map((t) => t.key)).toEqual(['section']);
    expect(registry.list({ storage: 'collection' }).map((t) => t.key)).toEqual(['post']);
  });

  describe('editor overrides', () => {
    it('accepts a path that names a field, a nested field and a list element field', () => {
      const registry = createContentTypeRegistry();
      expect(() =>
        registry.register(block({ editor: { overrides: { title: { label: 'T' }, 'cards.*': { label: 'Card' }, 'cards.*.heading': { label: 'H' } }, groups: [], custom: false } })),
      ).not.toThrow();
    });

    it.each(['missing', 'title.child', 'cards.heading', 'cards.0.heading', 'cards.*.missing', 'constructor'])('refuses the path "%s"', (path) => {
      const registry = createContentTypeRegistry();
      expect(() => registry.register(block({ editor: { overrides: { [path]: { label: 'x' } }, groups: [], custom: false } }))).toThrow(/names no field/);
    });

    it('refuses an override whose widget does not fit the field', () => {
      const registry = createContentTypeRegistry();
      expect(() => registry.register(block({ editor: { overrides: { title: { widget: 'switch' } }, groups: [], custom: false } }))).toThrow(/cannot use the "switch" widget/);
    });

    it('refuses a select with no options', () => {
      const registry = createContentTypeRegistry();
      expect(() => registry.register(block({ editor: { overrides: { title: { widget: 'select' } }, groups: [], custom: false } }))).toThrow(/no options/);
    });
  });

  describe('unsupported schemas', () => {
    const unsupported: [string, z.ZodType][] = [
      ['a free union of objects', z.object({ a: z.union([z.object({ x: z.string() }), z.object({ y: z.string() })]) })],
      ['a discriminated union', z.object({ a: z.discriminatedUnion('t', [z.object({ t: z.literal('a') }), z.object({ t: z.literal('b') })]) })],
      ['a record', z.object({ a: z.record(z.string(), z.string()) })],
      ['a tuple', z.object({ a: z.tuple([z.string()]) })],
      ['an unknown', z.object({ a: z.unknown() })],
      ['an any', z.object({ a: z.any() })],
      ['a recursive schema', z.object({ a: z.lazy(() => z.string()) })],
      ['a non-object root', z.string()],
    ];

    it.each(unsupported)('refuses %s', (_name, schema) => {
      expect(() => createContentTypeRegistry().register(block({ schema }))).toThrow(ContentValidationError);
    });

    it('names the field in the problem', () => {
      expect(() => createContentTypeRegistry().register(block({ schema: z.object({ a: z.object({ b: z.unknown() }) }) }))).toThrow(/a\.b/);
    });

    it('accepts them when the type is custom, and still checks override paths', () => {
      const schema = z.object({ a: z.unknown(), title: z.string() });
      const registry = createContentTypeRegistry();
      expect(() => registry.register(block({ schema, editor: { overrides: { title: { label: 'T' } }, groups: [], custom: true } }))).not.toThrow();
      expect(() => registry.register(block({ key: 'other', schema, editor: { overrides: { nope: { label: 'x' } }, groups: [], custom: true } }))).toThrow(/names no field/);
    });

    it('accepts what the generator supports: enums, literal unions, item refs, images, nested lists, optional and default', () => {
      const schema = z.object({
        kind: z.enum(['a', 'b']),
        tone: z.union([z.literal('x'), z.literal('y')]),
        link: z.url().optional(),
        count: z.number().int().default(1),
        refs: z.array(itemRefSchema),
        one: itemRefSchema.nullable(),
        nested: z.object({ list: z.array(z.object({ t: z.string() })) }),
      });
      expect(() => createContentTypeRegistry().register(block({ schema }))).not.toThrow();
    });
  });

  describe('slot limits', () => {
    it('refuses a slot whose max is over the cap, accepts the cap and no limit', () => {
      const registry = createContentTypeRegistry();
      expect(() => registry.register(container({ max: MAX_ITEMS_PER_SLOT + 1 }))).toThrow(/most a slot can hold/);
      expect(() => registry.register(container({ max: MAX_ITEMS_PER_SLOT }))).not.toThrow();
      expect(() => registry.register({ ...container({ max: null }), key: 'section-b' })).not.toThrow();
    });

    it('refuses a slot whose min is over the cap', () => {
      expect(() => createContentTypeRegistry().register(container({ min: MAX_ITEMS_PER_SLOT + 1 }))).toThrow(ContentValidationError);
    });
  });

  describe('validate()', () => {
    it('accepts slots that name block types registered later', () => {
      const registry = createContentTypeRegistry();
      registry.register(container());
      expect(() => registry.validate()).toThrow(/"hero", which is not registered/);
      registry.register(block());
      expect(() => registry.validate()).not.toThrow();
    });

    it('refuses a slot that names a container, a collection type, or a picker override naming nothing', () => {
      const registry = createContentTypeRegistry();
      registry.register(container());
      registry.register(block({ key: 'hero', kind: 'container', slots: [{ key: 'a', label: 'A', allowedTypeKeys: ['hero'] }] as never, translatable: false }));
      expect(() => registry.validate()).toThrow(/not a document block type/);

      const other = createContentTypeRegistry();
      other.register(container());
      other.register(block({ storage: 'collection', adapter: 'heroes', translatable: false }));
      expect(() => other.validate()).toThrow(/not a document block type/);

      const picker = createContentTypeRegistry();
      picker.register(block({ schema: z.object({ r: itemRefSchema }), editor: { overrides: { r: { allowedTypeKeys: ['ghost'] } }, groups: [], custom: false } }));
      expect(() => picker.validate()).toThrow(/"ghost", which is not registered/);
    });

    it('reports one line per problem', () => {
      const registry = createContentTypeRegistry();
      registry.register({ ...container(), slots: [{ key: 'a', label: 'A', allowedTypeKeys: ['x', 'y'] }] as never });
      try {
        registry.validate();
        expect.unreachable();
      } catch (error) {
        expect((error as ContentValidationError).issues).toHaveLength(2);
      }
    });
  });
});
