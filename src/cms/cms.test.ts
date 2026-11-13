import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ASSET_MAX_BYTES,
  BUILTIN_SECTION_TEMPLATES,
  CMS_LANGUAGES,
  CMS_ERROR_CODES,
  ContentReferencedError,
  NEUTRAL_LANGUAGE,
  UNIVERSAL_FALLBACK_LANGUAGE,
  assetRefSchema,
  assetSchema,
  contentItemSchema,
  contentTypeDefinitionSchema,
  editorFieldOverrideSchema,
  itemRefSchema,
  pageLayoutContentSchema,
  sectionTemplateSchema,
  slotDefinitionSchema,
} from './index';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const block = {
  key: 'hero',
  label: 'Hero',
  kind: 'block' as const,
  storage: 'document' as const,
  translatable: true,
  schema: z.object({ title: z.string() }),
  component: 'Hero',
};

describe('languages', () => {
  it('lists the three languages once and falls back to English', () => {
    expect(CMS_LANGUAGES).toEqual(['sl', 'en', 'de']);
    expect(UNIVERSAL_FALLBACK_LANGUAGE).toBe('en');
    expect(CMS_LANGUAGES).not.toContain(NEUTRAL_LANGUAGE);
  });
});

describe('contentTypeDefinitionSchema', () => {
  it('accepts a block and fills defaults', () => {
    const type = contentTypeDefinitionSchema.parse(block);
    expect(type.slots).toEqual([]);
    expect(type.editor).toEqual({ overrides: {}, groups: [], custom: false });
  });

  it('accepts a container with slots', () => {
    const container = {
      ...block,
      key: 'section',
      kind: 'container' as const,
      slots: [{ key: 'body', label: 'Body', allowedTypeKeys: ['hero'] }],
    };
    expect(contentTypeDefinitionSchema.parse(container).slots[0]).toMatchObject({ min: 0, max: null });
  });

  it.each([
    ['a block with slots', { slots: [{ key: 'a', label: 'A', allowedTypeKeys: ['x'] }] }],
    ['a container with no slots', { kind: 'container' }],
    ['a collection with no adapter', { storage: 'collection', translatable: false }],
    ['a document with an adapter', { adapter: 'posts' }],
    ['a translatable collection', { storage: 'collection', adapter: 'posts', translatable: true }],
    ['a bad key', { key: 'Hero' }],
    ['a schema that is not zod', { schema: {} }],
    ['an unknown field', { extra: 1 }],
  ])('rejects %s', (_name, change) => {
    expect(contentTypeDefinitionSchema.safeParse({ ...block, ...change }).success).toBe(false);
  });

  it('accepts a collection type with an adapter', () => {
    expect(contentTypeDefinitionSchema.safeParse({ ...block, key: 'blog-post', storage: 'collection', adapter: 'blog-posts', translatable: false }).success).toBe(true);
  });

  it('rejects two slots with the same key', () => {
    const slot = { key: 'a', label: 'A', allowedTypeKeys: ['x'] };
    const result = contentTypeDefinitionSchema.safeParse({ ...block, kind: 'container', slots: [slot, slot] });
    expect(result.success).toBe(false);
  });
});

describe('slots and editor overrides', () => {
  it('rejects min greater than max and an empty allowed list', () => {
    expect(slotDefinitionSchema.safeParse({ key: 'a', label: 'A', allowedTypeKeys: ['x'], min: 3, max: 2 }).success).toBe(false);
    expect(slotDefinitionSchema.safeParse({ key: 'a', label: 'A', allowedTypeKeys: [] }).success).toBe(false);
  });
  it('knows the widgets and refuses unknown override fields', () => {
    expect(editorFieldOverrideSchema.safeParse({ widget: 'richtext', group: 'Content', order: 2 }).success).toBe(true);
    expect(editorFieldOverrideSchema.safeParse({ widget: 'sparkle' }).success).toBe(false);
    expect(editorFieldOverrideSchema.safeParse({ colour: 'red' }).success).toBe(false);
  });
});

describe('items and references', () => {
  it('accepts an item ref by id and nothing else', () => {
    expect(itemRefSchema.safeParse({ $ref: id(1) }).success).toBe(true);
    expect(itemRefSchema.safeParse({ $ref: 'not-an-id' }).success).toBe(false);
    expect(itemRefSchema.safeParse({ $ref: id(1), extra: true }).success).toBe(false);
  });
  it('checks an item', () => {
    const item = { id: id(1), typeKey: 'hero', title: 'Landing hero', reusable: false, translatable: true, createdAt: '2026-11-14T10:00:00Z' };
    expect(contentItemSchema.safeParse(item).success).toBe(true);
    expect(contentItemSchema.safeParse({ ...item, title: '' }).success).toBe(false);
  });
});

describe('field markers for the generated editor', () => {
  it('tags the reference and image schemas so the editor picks the right widget', () => {
    expect(z.globalRegistry.get(itemRefSchema)).toMatchObject({ widget: 'item-ref' });
    expect(z.globalRegistry.get(assetRefSchema)).toMatchObject({ widget: 'image' });
  });
});

describe('templates', () => {
  it('parses every built-in template', () => {
    for (const template of BUILTIN_SECTION_TEMPLATES) expect(sectionTemplateSchema.safeParse(template).success).toBe(true);
    expect(BUILTIN_SECTION_TEMPLATES.map((t) => t.key)).toEqual(['banner-section', 'help-section', 'timeline-section']);
  });
  it('rejects a template with no slot or a repeated slot', () => {
    const base = { key: 'x', name: 'X', containerTypeKey: 'section' };
    expect(sectionTemplateSchema.safeParse({ ...base, slots: [] }).success).toBe(false);
    const slot = { key: 'a', label: 'A', allowedTypeKeys: ['banner'] };
    expect(sectionTemplateSchema.safeParse({ ...base, slots: [slot, slot] }).success).toBe(false);
  });
});

describe('page layouts', () => {
  const section = { key: 'hero', template: 'banner-section', slots: { banner: [id(1)] } };
  it('accepts ordered sections', () => {
    expect(pageLayoutContentSchema.safeParse({ sections: [section, { ...section, key: 'help', anchor: 'help' }] }).success).toBe(true);
    expect(pageLayoutContentSchema.safeParse({ sections: [] }).success).toBe(true);
  });
  it('rejects repeated section keys, ids that are not ids and too many items', () => {
    expect(pageLayoutContentSchema.safeParse({ sections: [section, section] }).success).toBe(false);
    expect(pageLayoutContentSchema.safeParse({ sections: [{ ...section, slots: { banner: ['x'] } }] }).success).toBe(false);
    expect(pageLayoutContentSchema.safeParse({ sections: [{ ...section, slots: { banner: Array.from({ length: 101 }, (_, i) => id(i)) } }] }).success).toBe(false);
  });
});

describe('assets', () => {
  const asset = { id: id(1), bucket: 'site-images', path: 'hero/a1.webp', mime: 'image/webp', bytes: 1000, width: 10, height: 10, label: null, createdAt: '2026-11-14T10:00:00Z' };
  it('accepts an image in the bucket', () => {
    expect(assetSchema.safeParse(asset).success).toBe(true);
  });
  it.each([
    ['a path outside the bucket', { path: '../x.png' }],
    ['a leading slash', { path: '/x.png' }],
    ['a type that is not an image', { mime: 'application/pdf' }],
    ['a file over the limit', { bytes: ASSET_MAX_BYTES + 1 }],
  ])('rejects %s', (_name, change) => {
    expect(assetSchema.safeParse({ ...asset, ...change }).success).toBe(false);
  });
});

describe('errors', () => {
  it('lists where a refused delete is used', () => {
    const usage = { sourceKind: 'layout' as const, sourceId: id(2), sourceLabel: 'home', sourceLanguage: null, inPublished: true, inNewest: true };
    const error = new ContentReferencedError(id(1), [usage]);
    expect(error.usages).toEqual([usage]);
    expect(error.message).toMatch(/1 place/);
  });
  it('keeps the stale-save code of the existing entries', () => {
    expect(CMS_ERROR_CODES.stale).toBe('CE001');
    expect(CMS_ERROR_CODES.cycle).toBe('CM008');
    expect(new Set(Object.values(CMS_ERROR_CODES)).size).toBe(Object.keys(CMS_ERROR_CODES).length);
  });
});
