import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { assetRefSchema, createContentTypeRegistry, describeFields, humanise, itemRefSchema, type ContentType, type ContentTypeInput, type EditorConfig } from './index';

const make = (schema: z.ZodType, editor: Partial<EditorConfig> = {}): ContentType =>
  createContentTypeRegistry().register({
    key: 'thing',
    label: 'Thing',
    kind: 'block',
    storage: 'document',
    translatable: true,
    schema,
    component: 'Thing',
    editor: { overrides: {}, groups: [], custom: false, ...editor },
  } satisfies ContentTypeInput);

const only = (schema: z.ZodType, editor: Partial<EditorConfig> = {}) => describeFields(make(z.object({ f: schema }), editor))[0]!;

describe('humanise', () => {
  it.each([
    ['title', 'Title'],
    ['ctaLabel', 'Cta label'],
    ['cta_label', 'Cta label'],
    ['cta-label', 'Cta label'],
  ])('%s -> %s', (input, expected) => expect(humanise(input)).toBe(expected));
});

describe('describeFields: widgets from the schema', () => {
  it('maps a string to text with its length limits, and a long one to a textarea', () => {
    expect(only(z.string().min(2).max(80))).toMatchObject({ widget: 'text', minLength: 2, maxLength: 80, required: true, path: 'f', label: 'F', group: 'Details', order: null, hidden: false, readOnly: false });
    expect(only(z.string().max(200)).widget).toBe('text');
    expect(only(z.string().max(201)).widget).toBe('textarea');
  });

  it('maps urls, calendar dates, numbers and booleans', () => {
    expect(only(z.url()).widget).toBe('url');
    expect(only(z.string().url()).widget).toBe('url');
    expect(only(z.iso.date()).widget).toBe('date');
    expect(only(z.number().int().min(1).max(9))).toMatchObject({ widget: 'number', integer: true, min: 1, max: 9 });
    expect(only(z.number())).toMatchObject({ widget: 'number', integer: false });
    expect(only(z.number().min(0))).not.toHaveProperty('max');
    expect(only(z.boolean()).widget).toBe('switch');
  });

  it('maps an enum and a union of literals to a select whose options are the values', () => {
    expect(only(z.enum(['a', 'b']))).toMatchObject({ widget: 'select', options: [{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }] });
    expect(only(z.union([z.literal('x'), z.literal('y')]))).toMatchObject({ widget: 'select', options: [{ value: 'x', label: 'x' }, { value: 'y', label: 'y' }] });
  });

  it('maps the asset and item reference schemas by their markers', () => {
    expect(only(assetRefSchema).widget).toBe('image');
    expect(only(assetRefSchema.optional())).toMatchObject({ widget: 'image', required: false });
    expect(only(itemRefSchema)).toMatchObject({ widget: 'item-ref', allowedTypeKeys: [] });
    expect(only(z.array(itemRefSchema).min(1).max(4))).toMatchObject({ widget: 'item-ref-list', min: 1, max: 4 });
  });

  it('maps an object to a group with dotted paths, and a list to a list whose element is `parent.*`', () => {
    const group = only(z.object({ city: z.string(), zip: z.string().optional() }));
    expect(group).toMatchObject({ widget: 'group', fields: [{ path: 'f.city', required: true }, { path: 'f.zip', required: false }] });

    const list = only(z.array(z.object({ title: z.string() })).min(1).max(3));
    expect(list).toMatchObject({ widget: 'list', min: 1, max: 3, item: { path: 'f.*', widget: 'group', required: true, fields: [{ path: 'f.*.title', widget: 'text' }] } });
    expect(only(z.array(z.string())).widget).toBe('list');
  });

  it('marks optional, nullable and defaulted fields as not required, and carries the default', () => {
    expect(only(z.string().optional())).toMatchObject({ required: false });
    expect(only(z.string().nullable())).toMatchObject({ required: false });
    const defaulted = only(z.string().default('hi'));
    expect(defaulted).toMatchObject({ widget: 'text', required: false, defaultValue: 'hi' });
    expect(only(z.string())).not.toHaveProperty('defaultValue');
    expect(only(z.number().default(0))).toMatchObject({ defaultValue: 0 });
  });

  it('returns nothing for a schema that is not an object (a custom type)', () => {
    expect(describeFields(make(z.string(), { custom: true }))).toEqual([]);
  });

  it('leaves out a field the generator cannot build when the type is custom', () => {
    const type = make(z.object({ a: z.unknown(), b: z.string() }), { custom: true });
    expect(describeFields(type).map((f) => f.path)).toEqual(['b']);
  });
});

describe('describeFields: overrides', () => {
  it('lets an override beat a marker beat the inferred widget', () => {
    expect(only(z.string(), { overrides: { f: { widget: 'richtext' } } }).widget).toBe('richtext');
    expect(only(assetRefSchema, { overrides: { f: { widget: 'text' } } }).widget).toBe('text');
    expect(only(assetRefSchema).widget).toBe('image');
    expect(only(z.string().max(500), { overrides: { f: { widget: 'text' } } }).widget).toBe('text');
  });

  it('applies label, help, placeholder, group, order, hidden, readOnly and rows', () => {
    const field = only(z.string(), { overrides: { f: { label: 'Headline', help: 'h', placeholder: 'p', group: 'Content', order: 3, hidden: true, readOnly: true, widget: 'textarea', rows: 6 } }, groups: ['Content'] });
    expect(field).toMatchObject({ label: 'Headline', help: 'h', placeholder: 'p', group: 'Content', order: 3, hidden: true, readOnly: true, widget: 'textarea', rows: 6 });
  });

  it('gives a select its option labels, and a string a select when an override says so', () => {
    const labelled = only(z.enum(['a', 'b']), { overrides: { f: { options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }] } } });
    expect(labelled).toMatchObject({ options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }] });
    expect(only(z.string(), { overrides: { f: { widget: 'select', options: [{ value: 'a', label: 'A' }] } } })).toMatchObject({ widget: 'select' });
  });

  it('takes allowedTypeKeys from the override, else from the registry keys passed in', () => {
    const type = make(z.object({ a: itemRefSchema, b: z.array(itemRefSchema) }), { overrides: { a: { allowedTypeKeys: ['card'] } } });
    expect(describeFields(type)).toMatchObject([{ allowedTypeKeys: ['card'] }, { allowedTypeKeys: [] }]);
    expect(describeFields(type, { blockTypeKeys: ['card', 'banner'] })).toMatchObject([{ allowedTypeKeys: ['card'] }, { allowedTypeKeys: ['card', 'banner'] }]);
  });

  it('applies overrides to nested fields and to the list element by dotted path', () => {
    const type = make(z.object({ cards: z.array(z.object({ title: z.string() })) }), { overrides: { 'cards.*.title': { label: 'Card title' }, 'cards.*': { label: 'Card' } } });
    const [cards] = describeFields(type);
    expect(cards).toMatchObject({ widget: 'list', item: { label: 'Card', fields: [{ path: 'cards.*.title', label: 'Card title' }] } });
  });
});

describe('describeFields: order and groups', () => {
  const schema = z.object({ a: z.string(), b: z.string(), c: z.string(), d: z.string() });

  it('puts ordered fields first by order, then the rest in schema order', () => {
    const fields = describeFields(make(schema, { overrides: { c: { order: 1 }, a: { order: 2 } } }));
    expect(fields.map((f) => f.path)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('orders accordions by editor.groups, with Details first when the type does not list it, and appends groups the overrides add', () => {
    const fields = describeFields(make(schema, { groups: ['Content', 'Style'], overrides: { a: { group: 'Style' }, b: { group: 'Content' }, c: { group: 'Extra' } } }));
    expect(fields.map((f) => [f.path, f.group])).toEqual([['d', 'Details'], ['b', 'Content'], ['a', 'Style'], ['c', 'Extra']]);
  });

  it('honours a type that lists Details itself', () => {
    const fields = describeFields(make(schema, { groups: ['Content', 'Details'], overrides: { a: { group: 'Content' } } }));
    expect(fields.map((f) => f.group)).toEqual(['Content', 'Details', 'Details', 'Details']);
  });

  it('keeps nested fields in their parent accordion', () => {
    const type = make(z.object({ box: z.object({ x: z.string() }) }), { overrides: { box: { group: 'Layout' } } });
    expect(describeFields(type)[0]).toMatchObject({ group: 'Layout', fields: [{ path: 'box.x', group: 'Layout' }] });
  });
});
