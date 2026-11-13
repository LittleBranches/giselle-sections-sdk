import { beforeEach, describe, expect, it } from 'vitest';

import { ContentConflictError, ContentValidationError } from '../content/errors';
import {
  BUILTIN_SECTION_TEMPLATES,
  ContentNotFoundError,
  ContentPermissionError,
  ContentReferenceError,
  ContentReferencedError,
  LayoutRuleError,
  createInMemoryCmsStore,
  type InMemoryCmsStore,
} from './index';

let store: InMemoryCmsStore;
beforeEach(() => {
  store = createInMemoryCmsStore();
  store.setRole('editor');
});

const asOwner = async <T>(fn: () => Promise<T>): Promise<T> => {
  const before = store.getRole();
  store.setRole('owner');
  try {
    return await fn();
  } finally {
    store.setRole(before);
  }
};

const rejects = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
};

const newItem = (typeKey = 'card', options: { translatable?: boolean; reusable?: boolean; title?: string } = {}) =>
  store.items.createItem({ typeKey, title: options.title ?? `${typeKey} item`, reusable: options.reusable ?? true, translatable: options.translatable ?? true });

/** An item with a published English entry. */
const published = async (typeKey = 'card', options: { translatable?: boolean; reusable?: boolean; content?: unknown } = {}) => {
  const item = await newItem(typeKey, options);
  const language = (options.translatable ?? true) ? 'en' : 'all';
  const version = await store.items.saveDraft(item.id, language, options.content ?? { text: 'hello' }, [], null);
  await store.items.publish(item.id, language, version);
  return item;
};

describe('roles', () => {
  it('lets a visitor and a member read published content only and write nothing', async () => {
    const item = await published();
    const draftVersion = await store.items.saveDraft(item.id, 'en', { text: 'draft' }, [], 1);
    expect(draftVersion).toBe(2);
    const layoutVersion = await store.layouts.saveDraft('home', { sections: [] }, [], null);
    await store.layouts.publish('home', layoutVersion);

    for (const role of ['visitor', 'member'] as const) {
      store.setRole(role);
      expect((await store.items.readPublished(item.id, 'en'))?.content).toEqual({ text: 'hello' });
      expect(await store.items.readNewest(item.id, 'en')).toBeNull();
      expect(await store.items.listVersions(item.id, 'en')).toEqual([]);
      expect(await store.items.listItems()).toEqual([]);
      expect(await store.items.listUsages(item.id)).toEqual([]);
      expect(await store.layouts.readNewest('home')).toBeNull();
      expect(await store.layouts.listVersions('home')).toEqual([]);
      expect(await store.layouts.listLayouts()).toEqual([]);
      expect((await store.layouts.readPublished('home'))?.version).toBe(1);
      expect((await store.templates.list()).length).toBe(BUILTIN_SECTION_TEMPLATES.length);

      const writes: Promise<unknown>[] = [
        newItem(),
        store.items.updateItem(item.id, { title: 'x' }),
        store.items.saveDraft(item.id, 'en', {}, [], 2),
        store.items.publish(item.id, 'en', 2),
        store.items.restore(item.id, 'en', 1, 2),
        store.items.deleteItem(item.id),
        store.layouts.saveDraft('home', { sections: [] }, [], 1),
        store.layouts.publish('home', 1),
        store.layouts.restore('home', 1, 1),
        store.layouts.reorderSlot('home', 's', 'x', [], 1),
        store.templates.save({ ...BUILTIN_SECTION_TEMPLATES[0]!, key: 'mine' }),
        store.assets.register({ path: 'a.png', mime: 'image/png', bytes: 10, width: null, height: null, label: null }),
      ];
      for (const write of writes) expect(await rejects(write)).toBeInstanceOf(ContentPermissionError);
    }
  });

  it('lets an editor write but only an owner delete an item or save a template', async () => {
    const item = await published();
    expect(await rejects(store.items.deleteItem(item.id))).toBeInstanceOf(ContentPermissionError);
    expect(await rejects(store.templates.save({ ...BUILTIN_SECTION_TEMPLATES[0]!, key: 'mine', builtIn: false }))).toBeInstanceOf(ContentPermissionError);
    await asOwner(() => store.items.deleteItem(item.id));
    await asOwner(() => store.templates.save({ ...BUILTIN_SECTION_TEMPLATES[0]!, key: 'mine', builtIn: false }));
    expect(await store.templates.get('mine')).not.toBeNull();
  });

  it('refuses a write before it looks at anything else (an unknown item is a permission error for a visitor)', async () => {
    store.setRole('visitor');
    expect(await rejects(store.items.saveDraft('00000000-0000-4000-8000-000000000999', 'en', {}, [], null))).toBeInstanceOf(ContentPermissionError);
  });
});

describe('items: create and update', () => {
  it('creates an item with its type, title, reusable flag and translatable flag', async () => {
    const item = await newItem('card', { title: 'First', reusable: false, translatable: false });
    expect(item).toMatchObject({ typeKey: 'card', title: 'First', reusable: false, translatable: false });
    expect(item.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(item.createdAt).toString()).not.toBe('Invalid Date');
  });

  it.each([
    ['a bad type key', { typeKey: 'Bad Key', title: 'ok' }],
    ['an empty title', { typeKey: 'card', title: '' }],
    ['a title over 120 characters', { typeKey: 'card', title: 'x'.repeat(121) }],
  ])('refuses %s', async (_label, input) => {
    expect(await rejects(store.items.createItem({ ...input, reusable: true, translatable: true }))).toBeInstanceOf(ContentValidationError);
  });

  it('renames and flips reusable, leaving a field alone when it is not passed; never changes translatable', async () => {
    const item = await newItem('card', { reusable: false });
    const renamed = await store.items.updateItem(item.id, { title: 'New' });
    expect(renamed).toMatchObject({ title: 'New', reusable: false, translatable: true, typeKey: 'card' });
    expect((await store.items.updateItem(item.id, { reusable: true })).title).toBe('New');
    expect(await rejects(store.items.updateItem(item.id, { title: '' }))).toBeInstanceOf(ContentValidationError);
    expect(await rejects(store.items.updateItem('00000000-0000-4000-8000-000000000999', { title: 'x' }))).toBeInstanceOf(ContentNotFoundError);
  });
});

describe('items: versions', () => {
  it('numbers versions from 1, creates the entry on first save, and never reuses a number', async () => {
    const item = await newItem();
    expect(await store.items.saveDraft(item.id, 'en', { text: 'a' }, [], null)).toBe(1);
    expect(await store.items.saveDraft(item.id, 'en', { text: 'b' }, [], 1)).toBe(2);
    expect(await store.items.saveDraft(item.id, 'de', { text: 'c' }, [], null)).toBe(1);
    const versions = await store.items.listVersions(item.id, 'en');
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions[0]).not.toHaveProperty('content');
    expect((await store.items.readNewest(item.id, 'en'))?.content).toEqual({ text: 'b' });
  });

  it('refuses a stale save with the newer version and writes nothing', async () => {
    const item = await newItem();
    await store.items.saveDraft(item.id, 'en', { text: 'a' }, [], null);
    await store.items.saveDraft(item.id, 'en', { text: 'b' }, [], 1);
    const error = (await rejects(store.items.saveDraft(item.id, 'en', { text: 'mine' }, [], 1))) as ContentConflictError;
    expect(error).toBeInstanceOf(ContentConflictError);
    expect(error.current).toMatchObject({ version: 2, content: { text: 'b' } });
    expect((await store.items.listVersions(item.id, 'en')).length).toBe(2);
    // a first save over an existing entry, and a save based on a version of an entry that does not exist, are stale too
    expect(await rejects(store.items.saveDraft(item.id, 'en', {}, [], null))).toBeInstanceOf(ContentConflictError);
    expect(await rejects(store.items.saveDraft(item.id, 'de', {}, [], 3))).toBeInstanceOf(ContentConflictError);
    expect(await store.items.readNewest(item.id, 'de')).toBeNull();
  });

  it('refuses a missing item, content that is not an object, and a bad language', async () => {
    const item = await newItem();
    expect(await rejects(store.items.saveDraft('00000000-0000-4000-8000-000000000999', 'en', {}, [], null))).toBeInstanceOf(ContentNotFoundError);
    for (const content of [null, 'text', 5, [1], undefined]) {
      expect(await rejects(store.items.saveDraft(item.id, 'en', content, [], null))).toBeInstanceOf(ContentValidationError);
    }
    expect(await rejects(store.items.saveDraft(item.id, 'english' as never, {}, [], null))).toBeInstanceOf(ContentValidationError);
  });

  it('keeps one entry, language all, for an item that is not translatable, and real languages only for one that is', async () => {
    const fixed = await newItem('card', { translatable: false });
    expect(await rejects(store.items.saveDraft(fixed.id, 'en', {}, [], null))).toBeInstanceOf(ContentValidationError);
    expect(await store.items.saveDraft(fixed.id, 'all', { n: 1 }, [], null)).toBe(1);
    const translated = await newItem('card', { translatable: true });
    expect(await rejects(store.items.saveDraft(translated.id, 'all', {}, [], null))).toBeInstanceOf(ContentValidationError);
  });

  it('does not let a caller change stored content through a returned object', async () => {
    const item = await newItem();
    const content = { nested: { n: 1 } };
    await store.items.saveDraft(item.id, 'en', content, [], null);
    content.nested.n = 2;
    const read = await store.items.readNewest(item.id, 'en');
    expect(read?.content).toEqual({ nested: { n: 1 } });
    (read!.content as { nested: { n: number } }).nested.n = 3;
    expect((await store.items.readNewest(item.id, 'en'))?.content).toEqual({ nested: { n: 1 } });
  });
});

describe('items: publish', () => {
  it('publishes the newest version only, moves the pointer and keeps the old published version readable until then', async () => {
    const item = await newItem();
    await store.items.saveDraft(item.id, 'en', { text: 'a' }, [], null);
    expect(await store.items.readPublished(item.id, 'en')).toBeNull();
    await store.items.publish(item.id, 'en', 1);
    await store.items.saveDraft(item.id, 'en', { text: 'b' }, [], 1);
    expect((await store.items.readPublished(item.id, 'en'))?.content).toEqual({ text: 'a' });
    const stale = (await rejects(store.items.publish(item.id, 'en', 1))) as ContentConflictError;
    expect(stale).toBeInstanceOf(ContentConflictError);
    expect(stale.current.version).toBe(2);
    await store.items.publish(item.id, 'en', 2);
    expect((await store.items.readPublished(item.id, 'en'))?.content).toEqual({ text: 'b' });
    expect((await store.items.listVersions(item.id, 'en')).map((v) => v.status)).toEqual(['published', 'published']);
  });

  it('refuses to publish a version that does not exist, or an entry that does not exist', async () => {
    const item = await newItem();
    expect(await rejects(store.items.publish(item.id, 'en', 1))).toBeInstanceOf(ContentValidationError);
    await store.items.saveDraft(item.id, 'en', {}, [], null);
    expect(await rejects(store.items.publish(item.id, 'en', 7))).toBeInstanceOf(ContentConflictError);
  });

  it('logs a publish once; publishing what is already live changes nothing and is not logged', async () => {
    const item = await newItem();
    await store.items.saveDraft(item.id, 'en', {}, [], null);
    await store.items.publish(item.id, 'en', 1);
    await store.items.publish(item.id, 'en', 1);
    const log = store.changeLog().filter((entry) => entry.action === 'publish_item');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ subjectId: item.id, language: 'en', version: 1 });
  });
});

describe('items: restore', () => {
  it('makes a new version with the old content and restoredFrom, leaving the old one untouched', async () => {
    const item = await newItem();
    await store.items.saveDraft(item.id, 'en', { text: 'a' }, [], null);
    await store.items.saveDraft(item.id, 'en', { text: 'b' }, [], 1);
    expect(await store.items.restore(item.id, 'en', 1, 2)).toBe(3);
    const newest = await store.items.readNewest(item.id, 'en');
    expect(newest).toMatchObject({ version: 3, content: { text: 'a' }, restoredFrom: 1, status: 'draft' });
    expect((await store.items.listVersions(item.id, 'en')).map((v) => v.version)).toEqual([3, 2, 1]);
  });

  it('refuses a stale base, a missing version and a missing entry', async () => {
    const item = await newItem();
    await store.items.saveDraft(item.id, 'en', {}, [], null);
    await store.items.saveDraft(item.id, 'en', {}, [], 1);
    expect(await rejects(store.items.restore(item.id, 'en', 1, 1))).toBeInstanceOf(ContentConflictError);
    expect(await rejects(store.items.restore(item.id, 'en', 9, 2))).toBeInstanceOf(ContentValidationError);
    expect(await rejects(store.items.restore(item.id, 'de', 1, null))).toBeInstanceOf(ContentValidationError);
    expect((await store.items.listVersions(item.id, 'en')).length).toBe(2);
  });

  it('copies the references of the old version and checks them again (CM003 when a target is gone)', async () => {
    const target = await published('card');
    const source = await newItem('section', { translatable: true });
    await store.items.saveDraft(source.id, 'en', { c: { $ref: target.id } }, [target.id], null);
    await store.items.saveDraft(source.id, 'en', { c: null }, [], 1);
    expect(await store.items.restore(source.id, 'en', 1, 2)).toBe(3);
    expect((await store.items.listUsages(target.id)).map((u) => u.sourceId)).toEqual([source.id]);

    await store.items.saveDraft(source.id, 'en', { c: null }, [], 3);
    await asOwner(() => store.items.deleteItem(target.id));
    const error = (await rejects(store.items.restore(source.id, 'en', 1, 4))) as ContentReferenceError;
    expect(error).toMatchObject({ reason: 'missing', itemIds: [target.id] });
    expect((await store.items.listVersions(source.id, 'en')).length).toBe(4);
  });
});

describe('references: saving', () => {
  it('refuses a reference to an item that does not exist, listing the missing ids (CM003)', async () => {
    const source = await newItem('section');
    const ghost = '00000000-0000-4000-8000-000000000999';
    const error = (await rejects(store.items.saveDraft(source.id, 'en', {}, [ghost], null))) as ContentReferenceError;
    expect(error).toBeInstanceOf(ContentReferenceError);
    expect(error.reason).toBe('missing');
    expect(error.itemIds).toEqual([ghost]);
    expect(await store.items.readNewest(source.id, 'en')).toBeNull();
  });

  it('refuses an item that refers to itself, and a circle through other items (CM008)', async () => {
    const a = await newItem('section');
    const b = await newItem('section');
    const c = await newItem('section');
    const self = (await rejects(store.items.saveDraft(a.id, 'en', {}, [a.id], null))) as ContentReferenceError;
    expect(self).toMatchObject({ reason: 'cycle' });
    expect(self.itemIds).toEqual([a.id, a.id]);

    await store.items.saveDraft(a.id, 'en', {}, [b.id], null);
    await store.items.saveDraft(b.id, 'en', {}, [c.id], null);
    const circle = (await rejects(store.items.saveDraft(c.id, 'en', {}, [a.id], null))) as ContentReferenceError;
    expect(circle).toMatchObject({ reason: 'cycle' });
    expect(circle.itemIds[0]).toBe(c.id);
    expect(circle.itemIds[circle.itemIds.length - 1]).toBe(c.id);
    expect(circle.itemIds).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(await store.items.readNewest(c.id, 'en')).toBeNull();
  });

  it('follows references through the published version too, so a published edge still counts', async () => {
    const a = await newItem('section');
    const b = await newItem('section');
    await store.items.saveDraft(a.id, 'en', {}, [b.id], null);
    await store.items.publish(a.id, 'en', 1);
    await store.items.saveDraft(a.id, 'en', {}, [], 1); // the newest no longer refers to b, the published one does
    expect(await rejects(store.items.saveDraft(b.id, 'en', {}, [a.id], null))).toMatchObject({ reason: 'cycle' });
  });

  it('ignores an old version that neither the newest nor the published one of its source holds', async () => {
    const a = await newItem('section');
    const b = await newItem('section');
    await store.items.saveDraft(a.id, 'en', {}, [b.id], null); // v1 refers to b, never published
    await store.items.saveDraft(a.id, 'en', {}, [], 1); // v2 does not
    await store.items.saveDraft(b.id, 'en', {}, [a.id], null);
    expect(await store.items.listUsages(a.id)).toHaveLength(1);
  });

  it('allows a diamond (two parents, one shared target) and a repeated id in one save', async () => {
    const shared = await newItem('card', { reusable: true });
    const a = await newItem('section');
    const b = await newItem('section');
    await store.items.saveDraft(a.id, 'en', {}, [shared.id, shared.id], null);
    await store.items.saveDraft(b.id, 'en', {}, [shared.id], null);
    expect(await store.items.listUsages(shared.id)).toHaveLength(2);
  });

  it('lets one source use a non-reusable item and refuses a second source (CM005), in any language of the first', async () => {
    const block = await newItem('card', { reusable: false });
    const first = await newItem('section');
    const second = await newItem('section');
    await store.items.saveDraft(first.id, 'en', {}, [block.id], null);
    await store.items.saveDraft(first.id, 'en', {}, [block.id], 1); // the same source again, in a later version
    await store.items.saveDraft(first.id, 'de', {}, [block.id], null); // the same source item, another language
    const error = (await rejects(store.items.saveDraft(second.id, 'en', {}, [block.id], null))) as ContentReferenceError;
    expect(error).toMatchObject({ reason: 'not-reusable', itemIds: [block.id] });
    await store.items.updateItem(block.id, { reusable: true });
    await store.items.saveDraft(second.id, 'en', {}, [block.id], null);
  });

  it('counts only references in a source\'s newest or published version for the CM005 rule', async () => {
    const block = await newItem('card', { reusable: false });
    const first = await newItem('section');
    const second = await newItem('section');
    await store.items.saveDraft(first.id, 'en', {}, [block.id], null); // v1 refers
    await store.items.saveDraft(first.id, 'en', {}, [], 1); // v2 does not; v1 was never published
    await store.items.saveDraft(second.id, 'en', {}, [block.id], null);
    expect((await store.items.listUsages(block.id)).map((u) => u.sourceId)).toEqual([second.id]);
  });

  it('applies the same checks to a layout that places items', async () => {
    const block = await newItem('banner', { reusable: false });
    const other = await newItem('section');
    await store.items.saveDraft(other.id, 'en', {}, [block.id], null);
    const content = { sections: [{ key: 'hero', template: 'banner-section', slots: { banner: [block.id] } }] };
    expect(await rejects(store.layouts.saveDraft('home', content, [block.id], null))).toMatchObject({ reason: 'not-reusable' });
    const ghost = '00000000-0000-4000-8000-000000000999';
    expect(await rejects(store.layouts.saveDraft('home', content, [ghost], null))).toMatchObject({ reason: 'missing' });
  });
});

describe('items: updateItem reusable', () => {
  it('refuses to stop being reusable while used by more than one source, allows it for one or none (CM005)', async () => {
    const block = await newItem('card', { reusable: true });
    const a = await newItem('section');
    const b = await newItem('section');
    await store.items.saveDraft(a.id, 'en', {}, [block.id], null);
    expect((await store.items.updateItem(block.id, { reusable: false })).reusable).toBe(false);
    await store.items.updateItem(block.id, { reusable: true });
    await store.items.saveDraft(b.id, 'en', {}, [block.id], null);
    const error = await rejects(store.items.updateItem(block.id, { reusable: false }));
    expect(error).toMatchObject({ reason: 'not-reusable', itemIds: expect.arrayContaining([a.id, b.id]) });
    expect((await store.items.listItems()).find((i) => i.id === block.id)?.reusable).toBe(true);
  });

  it('counts a source once however many languages and versions refer to it', async () => {
    const block = await newItem('card', { reusable: true });
    const a = await newItem('section');
    await store.items.saveDraft(a.id, 'en', {}, [block.id], null);
    await store.items.saveDraft(a.id, 'de', {}, [block.id], null);
    expect((await store.items.updateItem(block.id, { reusable: false })).reusable).toBe(false);
  });
});

describe('usages and delete', () => {
  it('lists where an item is used, with the published and newest flags, items and layouts', async () => {
    const target = await newItem('banner');
    const source = await newItem('section', { title: 'Parent' });
    await store.items.saveDraft(source.id, 'en', {}, [target.id], null);
    await store.items.publish(source.id, 'en', 1);
    await store.items.saveDraft(source.id, 'en', {}, [], 1);
    const content = { sections: [{ key: 'hero', template: 'banner-section', slots: { banner: [target.id] } }] };
    await store.layouts.saveDraft('home', content, [target.id], null);

    const usages = await store.items.listUsages(target.id);
    expect(usages).toEqual([
      { sourceKind: 'item', sourceId: source.id, sourceLabel: 'Parent', sourceLanguage: 'en', inPublished: true, inNewest: false },
      { sourceKind: 'layout', sourceId: expect.any(String), sourceLabel: 'home', sourceLanguage: null, inPublished: false, inNewest: true },
    ]);
    expect((await store.items.listItems()).find((i) => i.id === target.id)?.usageCount).toBe(2);
    await store.items.saveDraft(source.id, 'de', {}, [target.id], null);
    expect((await store.items.listUsages(target.id)).filter((u) => u.sourceKind === 'item')).toHaveLength(2);
    expect((await store.items.listItems()).find((i) => i.id === target.id)?.usageCount).toBe(2);
  });

  it('refuses to delete a referenced item with the usages, and deletes nothing (CM002)', async () => {
    const target = await published('banner');
    const source = await newItem('section');
    await store.items.saveDraft(source.id, 'en', {}, [target.id], null);
    const error = (await asOwner(() => rejects(store.items.deleteItem(target.id)))) as ContentReferencedError;
    expect(error).toBeInstanceOf(ContentReferencedError);
    expect(error.itemId).toBe(target.id);
    expect(error.usages).toHaveLength(1);
    expect((await store.items.readPublished(target.id, 'en'))?.version).toBe(1);
  });

  it('still refuses while only the published version of a source refers to it, and allows it once nothing counts', async () => {
    const target = await published('banner');
    const source = await newItem('section');
    await store.items.saveDraft(source.id, 'en', {}, [target.id], null);
    await store.items.publish(source.id, 'en', 1);
    await store.items.saveDraft(source.id, 'en', {}, [], 1);
    expect(await asOwner(() => rejects(store.items.deleteItem(target.id)))).toBeInstanceOf(ContentReferencedError);
    await store.items.publish(source.id, 'en', 2);
    await asOwner(() => store.items.deleteItem(target.id));
    expect(await store.items.readPublished(target.id, 'en')).toBeNull();
    expect((await store.items.listItems()).map((i) => i.id)).toEqual([source.id]);
    expect(store.changeLog().some((entry) => entry.action === 'delete_item' && entry.subjectId === target.id)).toBe(true);
  });

  it('deletes an unreferenced item with its history and its own outgoing references', async () => {
    const target = await published('banner');
    const source = await newItem('section');
    await store.items.saveDraft(source.id, 'en', {}, [target.id], null);
    expect(await store.items.listUsages(target.id)).toHaveLength(1);
    await asOwner(() => store.items.deleteItem(source.id));
    expect(await store.items.listUsages(target.id)).toEqual([]);
    expect(await store.items.listVersions(source.id, 'en')).toEqual([]);
    expect(await rejects(store.items.updateItem(source.id, { title: 'x' }))).toBeInstanceOf(ContentNotFoundError);
    await asOwner(() => store.items.deleteItem(target.id));
  });

  it('refuses deleting an item that does not exist', async () => {
    expect(await asOwner(() => rejects(store.items.deleteItem('00000000-0000-4000-8000-000000000999')))).toBeInstanceOf(ContentNotFoundError);
  });
});

describe('items: language fallback and preview at read', () => {
  it('serves the language asked for, else English, else nothing', async () => {
    const item = await newItem();
    await store.items.saveDraft(item.id, 'en', { text: 'english' }, [], null);
    await store.items.publish(item.id, 'en', 1);
    await store.items.saveDraft(item.id, 'sl', { text: 'slovenski' }, [], null);
    await store.items.publish(item.id, 'sl', 1);
    store.setRole('visitor');
    const [sl] = await store.items.resolveItems([item.id], 'sl', false);
    expect(sl).toMatchObject({ language: 'sl', content: { text: 'slovenski' }, isDraft: false, status: 'published', itemId: item.id, typeKey: 'card', translatable: true, reusable: true, version: 1 });
    const [de] = await store.items.resolveItems([item.id], 'de', false);
    expect(de).toMatchObject({ language: 'en', content: { text: 'english' } });
    expect((await store.items.resolveItems([item.id], 'en', false))[0]?.language).toBe('en');
  });

  it('leaves out an item with nothing to show, and one that does not exist, and keeps the order asked for', async () => {
    const a = await published('card', { content: { n: 1 } });
    const b = await published('card', { content: { n: 2 } });
    const empty = await newItem();
    const draftOnly = await newItem();
    await store.items.saveDraft(draftOnly.id, 'en', {}, [], null);
    const ghost = '00000000-0000-4000-8000-000000000999';
    const result = await store.items.resolveItems([b.id, ghost, empty.id, draftOnly.id, a.id, b.id], 'en', false);
    expect(result.map((r) => r.itemId)).toEqual([b.id, a.id]);
  });

  it('serves a published English entry rather than a draft-only entry in the language asked for, for a visitor', async () => {
    const item = await published();
    await store.items.saveDraft(item.id, 'de', { text: 'entwurf' }, [], null);
    store.setRole('visitor');
    expect((await store.items.resolveItems([item.id], 'de', false))[0]).toMatchObject({ language: 'en', isDraft: false });
    expect((await store.items.resolveItems([item.id], 'de', true))[0]).toMatchObject({ language: 'en', isDraft: false });
  });

  it('shows an editor in preview the newest version, and a draft-only language instead of falling to English', async () => {
    const item = await published();
    await store.items.saveDraft(item.id, 'en', { text: 'newer draft' }, [], 1);
    await store.items.saveDraft(item.id, 'de', { text: 'entwurf' }, [], null);
    expect((await store.items.resolveItems([item.id], 'en', true))[0]).toMatchObject({ content: { text: 'newer draft' }, isDraft: true, status: 'draft', version: 2 });
    expect((await store.items.resolveItems([item.id], 'de', true))[0]).toMatchObject({ language: 'de', isDraft: true, content: { text: 'entwurf' } });
    // not a preview: published only
    expect((await store.items.resolveItems([item.id], 'en', false))[0]).toMatchObject({ content: { text: 'hello' }, isDraft: false, version: 1 });
    expect((await store.items.resolveItems([item.id], 'de', false))[0]).toMatchObject({ language: 'en' });
  });

  it('does not mark the newest version as a draft when it is the published one', async () => {
    const item = await published();
    expect((await store.items.resolveItems([item.id], 'en', true))[0]).toMatchObject({ isDraft: false, status: 'published' });
  });

  it('shows nothing extra to a visitor or a member who sets the preview flag', async () => {
    const item = await published();
    await store.items.saveDraft(item.id, 'en', { text: 'secret draft' }, [], 1);
    for (const role of ['visitor', 'member'] as const) {
      store.setRole(role);
      const [resolved] = await store.items.resolveItems([item.id], 'en', true);
      expect(resolved).toMatchObject({ content: { text: 'hello' }, isDraft: false, version: 1 });
    }
  });

  it('serves a non-translatable item from its one entry whatever language is asked, and never from a language entry', async () => {
    const item = await newItem('card', { translatable: false });
    await store.items.saveDraft(item.id, 'all', { text: 'same' }, [], null);
    await store.items.publish(item.id, 'all', 1);
    for (const language of ['sl', 'en', 'de'] as const) {
      expect((await store.items.resolveItems([item.id], language, false))[0]).toMatchObject({ language: 'all', content: { text: 'same' } });
    }
  });

  it('accepts at most 500 ids', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(await rejects(store.items.resolveItems(ids, 'en', false))).toBeInstanceOf(ContentValidationError);
    expect(await store.items.resolveItems(ids.slice(0, 500), 'en', false)).toEqual([]);
  });

  it('reads the exact entry with no fallback', async () => {
    const item = await published();
    expect(await store.items.readPublished(item.id, 'de')).toBeNull();
  });
});

describe('items: listItems', () => {
  it('lists items with their published languages, optionally of one type', async () => {
    const card = await published('card');
    await store.items.saveDraft(card.id, 'sl', {}, [], null);
    await store.items.publish(card.id, 'sl', 1);
    const fixed = await published('banner', { translatable: false });
    const all = await store.items.listItems();
    expect(all.find((i) => i.id === card.id)?.publishedLanguages.sort()).toEqual(['en', 'sl']);
    expect(all.find((i) => i.id === fixed.id)?.publishedLanguages).toEqual(['all']);
    expect((await store.items.listItems({ typeKey: 'banner' })).map((i) => i.id)).toEqual([fixed.id]);
  });
});

describe('layouts', () => {
  const heroContent = (itemIds: string[], extra: Record<string, string[]> = {}) => ({
    sections: [{ key: 'hero', template: 'banner-section', slots: { banner: itemIds, ...extra } }],
  });

  it('versions a layout like an item: first save creates it, stale refused, only the newest published, restore makes a new version', async () => {
    const banner = await published('banner');
    expect(await store.layouts.saveDraft('home', heroContent([banner.id]), [banner.id], null)).toBe(1);
    expect(await store.layouts.saveDraft('home', heroContent([]), [], 1)).toBe(2);
    const stale = (await rejects(store.layouts.saveDraft('home', heroContent([]), [], 1))) as ContentConflictError;
    expect(stale).toBeInstanceOf(ContentConflictError);
    expect(stale.current.version).toBe(2);
    expect(await rejects(store.layouts.publish('home', 1))).toBeInstanceOf(ContentConflictError);
    expect(await rejects(store.layouts.publish('nope', 1))).toBeInstanceOf(ContentNotFoundError);
    expect(await store.layouts.readPublished('home')).toBeNull();
    expect(await store.layouts.restore('home', 1, 2)).toBe(3);
    expect(await store.layouts.readNewest('home')).toMatchObject({ version: 3, restoredFrom: 1, pageKey: 'home' });
    await store.layouts.publish('home', 3);
    expect((await store.layouts.readPublished('home'))?.version).toBe(3);
    expect((await store.layouts.listLayouts())[0]).toMatchObject({ pageKey: 'home', publishedVersion: 3 });
    expect((await store.layouts.listVersions('home')).map((v) => v.version)).toEqual([3, 2, 1]);
    expect(await rejects(store.layouts.restore('home', 9, 3))).toBeInstanceOf(ContentValidationError);
  });

  it('reads a layout for a page: the published one, the newest only for an editor in preview, never an error', async () => {
    expect(await store.layouts.read('home', true)).toBeNull();
    await store.layouts.saveDraft('home', { sections: [] }, [], null);
    expect(await store.layouts.read('home', false)).toBeNull();
    expect(await store.layouts.read('home', true)).toMatchObject({ pageKey: 'home', version: 1, status: 'draft', isDraft: true });
    await store.layouts.publish('home', 1);
    await store.layouts.saveDraft('home', { sections: [{ key: 'a', template: 'banner-section', slots: {} }] }, [], 1);
    expect(await store.layouts.read('home', true)).toMatchObject({ version: 2, isDraft: true });
    expect(await store.layouts.read('home', false)).toMatchObject({ version: 1, status: 'published', isDraft: false });
    for (const role of ['visitor', 'member'] as const) {
      store.setRole(role);
      expect(await store.layouts.read('home', true)).toMatchObject({ version: 1, isDraft: false });
    }
  });

  it('logs a layout publish once', async () => {
    await store.layouts.saveDraft('home', { sections: [] }, [], null);
    await store.layouts.publish('home', 1);
    await store.layouts.publish('home', 1);
    expect(store.changeLog().filter((e) => e.action === 'publish_layout')).toHaveLength(1);
  });

  it('refuses content that is not a layout, and a bad page key', async () => {
    expect(await rejects(store.layouts.saveDraft('home', { nope: 1 }, [], null))).toBeInstanceOf(ContentValidationError);
    expect(await rejects(store.layouts.saveDraft('home', null, [], null))).toBeInstanceOf(ContentValidationError);
    expect(await rejects(store.layouts.saveDraft('Bad Key', { sections: [] }, [], null))).toBeInstanceOf(ContentValidationError);
  });

  it('enforces allowed types and the maximum on every save (CM004)', async () => {
    const banner = await published('banner');
    const card = await published('card');
    const wrongType = (await rejects(store.layouts.saveDraft('home', heroContent([card.id]), [card.id], null))) as LayoutRuleError;
    expect(wrongType).toBeInstanceOf(LayoutRuleError);
    expect(wrongType.issues[0]).toMatch(/hero\.banner/);
    expect(wrongType.issues[0]).toMatch(/card/);
    const second = await published('banner');
    const tooMany = (await rejects(store.layouts.saveDraft('home', heroContent([banner.id, second.id]), [banner.id, second.id], null))) as LayoutRuleError;
    expect(tooMany.issues[0]).toMatch(/at most 1/);
    expect(await store.layouts.readNewest('home')).toBeNull();
  });

  it('reports an unknown template, an unknown slot and a slot item that does not exist even when the references omit it', async () => {
    const issuesOf = async (content: unknown, refs: string[]) => ((await rejects(store.layouts.saveDraft('home', content, refs, null))) as LayoutRuleError).issues.join('\n');
    expect(await issuesOf({ sections: [{ key: 'x', template: 'nope', slots: {} }] }, [])).toMatch(/template "nope"/);
    expect(await issuesOf(heroContent([], { ghost: [] }), [])).toMatch(/hero\.ghost/);
    expect(await issuesOf(heroContent(['00000000-0000-4000-8000-000000000999']), [])).toMatch(/item .* does not exist/);
  });

  it('does not enforce the minimum on a draft save but does on publish (CM007)', async () => {
    const draft = await store.layouts.saveDraft('home', heroContent([]), [], null);
    expect(draft).toBe(1);
    const error = (await rejects(store.layouts.publish('home', 1))) as LayoutRuleError;
    expect(error).toBeInstanceOf(LayoutRuleError);
    expect(error.issues.join('\n')).toMatch(/hero\.banner.*at least 1/);
    expect(await store.layouts.readPublished('home')).toBeNull();
    // a template slot the section does not mention counts as empty
    await store.layouts.saveDraft('home', { sections: [{ key: 'hero', template: 'banner-section', slots: {} }] }, [], 1);
    expect(await rejects(store.layouts.publish('home', 2))).toBeInstanceOf(LayoutRuleError);
    const banner = await published('banner');
    await store.layouts.saveDraft('home', heroContent([banner.id]), [banner.id], 2);
    await store.layouts.publish('home', 3);
    expect((await store.layouts.readPublished('home'))?.version).toBe(3);
  });

  it('re-checks every slot rule at publish, not only the minimums, after a template changed', async () => {
    const banner = await published('banner');
    await store.layouts.saveDraft('home', heroContent([banner.id]), [banner.id], null);
    await asOwner(() => store.templates.save({ ...BUILTIN_SECTION_TEMPLATES[0]!, slots: [{ key: 'banner', label: 'Banner', allowedTypeKeys: ['card'], min: 0, max: 1 }] }));
    const error = (await rejects(store.layouts.publish('home', 1))) as LayoutRuleError;
    expect(error).toBeInstanceOf(LayoutRuleError);
    expect(error.issues[0]).toMatch(/not allowed/);
    expect(error.message).toMatch(/breaks the rules/);
  });

  it('checks the stale version before the slot rules on publish', async () => {
    await store.layouts.saveDraft('home', heroContent([]), [], null);
    await store.layouts.saveDraft('home', heroContent([]), [], 1);
    expect(await rejects(store.layouts.publish('home', 1))).toBeInstanceOf(ContentConflictError);
  });

  it('reorders a slot into a new draft version, keeping the same items', async () => {
    const a = await published('card');
    const b = await published('card');
    const c = await published('card');
    const content = { sections: [{ key: 'help', template: 'help-section', slots: { cards: [a.id, b.id, c.id] } }] };
    await store.layouts.saveDraft('home', content, [a.id, b.id, c.id], null);
    expect(await store.layouts.reorderSlot('home', 'help', 'cards', [c.id, a.id, b.id], 1)).toBe(2);
    expect(((await store.layouts.readNewest('home'))?.content as typeof content).sections[0]?.slots.cards).toEqual([c.id, a.id, b.id]);
    expect((await store.items.listUsages(a.id)).length).toBe(1);

    expect(await rejects(store.layouts.reorderSlot('home', 'help', 'cards', [a.id, b.id, c.id], 1))).toBeInstanceOf(ContentConflictError);
    expect(await rejects(store.layouts.reorderSlot('home', 'help', 'cards', [a.id, b.id], 2))).toBeInstanceOf(ContentValidationError);
    expect(await rejects(store.layouts.reorderSlot('home', 'help', 'cards', [a.id, a.id, b.id], 2))).toBeInstanceOf(ContentValidationError);
    expect(await rejects(store.layouts.reorderSlot('home', 'help', 'cards', [a.id, b.id, '00000000-0000-4000-8000-000000000999'], 2))).toBeInstanceOf(ContentValidationError);
    expect(await rejects(store.layouts.reorderSlot('home', 'nope', 'cards', [a.id, b.id, c.id], 2))).toBeInstanceOf(ContentValidationError);
    expect(await rejects(store.layouts.reorderSlot('home', 'help', 'nope', [a.id, b.id, c.id], 2))).toBeInstanceOf(ContentValidationError);
    expect(await rejects(store.layouts.reorderSlot('missing', 'help', 'cards', [], 1))).toBeInstanceOf(ContentNotFoundError);
    expect((await store.layouts.listVersions('home')).length).toBe(2);
  });

  it('applies the slot rules again on restore', async () => {
    const banner = await published('banner');
    await store.layouts.saveDraft('home', heroContent([banner.id]), [banner.id], null);
    await store.layouts.saveDraft('home', heroContent([]), [], 1);
    // a template that now allows nothing the old version holds
    await asOwner(() => store.templates.save({ ...BUILTIN_SECTION_TEMPLATES[0]!, slots: [{ key: 'banner', label: 'Banner', allowedTypeKeys: ['card'], min: 0, max: 1 }] }));
    expect(await rejects(store.layouts.restore('home', 1, 2))).toBeInstanceOf(LayoutRuleError);
  });
});

describe('templates', () => {
  it('seeds the built-in templates, readable by anyone', async () => {
    store.setRole('visitor');
    const list = await store.templates.list();
    expect(list.map(({ createdAt: _c, updatedAt: _u, ...template }) => template)).toEqual(BUILTIN_SECTION_TEMPLATES);
    expect((await store.templates.get('banner-section'))?.builtIn).toBe(true);
    expect(await store.templates.get('nope')).toBeNull();
  });

  it('lets an owner create and replace a template, never changing built-in', async () => {
    store.setRole('owner');
    const slots = [{ key: 'body', label: 'Body', allowedTypeKeys: ['card'], min: 0, max: null }];
    const created = await store.templates.save({ key: 'mine', name: 'Mine', containerTypeKey: 'section', slots, builtIn: true });
    expect(created.builtIn).toBe(false);
    const replaced = await store.templates.save({ key: 'mine', name: 'Renamed', containerTypeKey: 'section', slots, builtIn: false });
    expect(replaced).toMatchObject({ name: 'Renamed', builtIn: false, createdAt: created.createdAt });
    const builtIn = await store.templates.save({ ...BUILTIN_SECTION_TEMPLATES[0]!, name: 'Changed', builtIn: false });
    expect(builtIn).toMatchObject({ name: 'Changed', builtIn: true });
    expect(store.changeLog().filter((e) => e.action === 'save_template')).toHaveLength(3);
  });

  it('refuses a slot limit above 100', async () => {
    store.setRole('owner');
    const slot = { key: 'body', label: 'Body', allowedTypeKeys: ['card'], min: 0, max: 101 };
    expect(await rejects(store.templates.save({ key: 'big', name: 'Big', containerTypeKey: 'section', slots: [slot], builtIn: false }))).toBeInstanceOf(ContentValidationError);
    expect(await rejects(store.templates.save({ key: 'big', name: 'Big', containerTypeKey: 'section', slots: [{ ...slot, max: null, min: 101 }], builtIn: false }))).toBeInstanceOf(ContentValidationError);
  });

  it('refuses an invalid template', async () => {
    store.setRole('owner');
    expect(await rejects(store.templates.save({ key: 'Bad', name: '', containerTypeKey: 'section', slots: [], builtIn: false }))).toBeInstanceOf(ContentValidationError);
  });
});

describe('assets', () => {
  const file = { path: 'photos/a.png', mime: 'image/png' as const, bytes: 1000, width: 10, height: 10, label: 'A' };

  it('registers a file that is in the bucket, returns the existing row for the same path, and lists them for anyone', async () => {
    store.uploadObject('photos/a.png');
    const asset = await store.assets.register(file);
    expect(asset).toMatchObject({ ...file, bucket: 'site-images' });
    expect(await store.assets.register({ ...file, label: 'Changed', bytes: 5 })).toEqual(asset);
    store.setRole('visitor');
    expect(await store.assets.list()).toEqual([asset]);
    expect(await store.assets.get(asset.id)).toEqual(asset);
    expect(await store.assets.get('00000000-0000-4000-8000-000000000999')).toBeNull();
    expect(store.changeLog().filter((e) => e.action === 'register_asset')).toHaveLength(1);
  });

  it('refuses a file that is not in the bucket, a bad path, a bad type and a bad size', async () => {
    expect(await rejects(store.assets.register(file))).toBeInstanceOf(ContentValidationError);
    store.uploadObject('../x.png');
    store.uploadObject('/x.png');
    store.uploadObject('x.gif');
    store.uploadObject('x.png');
    for (const bad of [{ ...file, path: '../x.png' }, { ...file, path: '/x.png' }, { ...file, path: 'x.png', mime: 'image/gif' as never }, { ...file, path: 'x.png', bytes: 5 * 1024 * 1024 + 1 }, { ...file, path: 'x.png', bytes: 0 }]) {
      expect(await rejects(store.assets.register(bad))).toBeInstanceOf(ContentValidationError);
    }
    expect(await store.assets.list()).toEqual([]);
  });
});

describe('legacy entries', () => {
  it('keeps the existing section entries working through the same store', async () => {
    expect(await store.saveDraft('hero', 'sl', { a: 1 }, null)).toBe(1);
    await store.publish('hero', 'sl', 1);
    expect((await store.readPublished('hero', 'sl'))?.content).toEqual({ a: 1 });
  });
});

describe('pages', () => {
  const about = { pageKey: 'about', slug: 'about-us', titles: { en: 'About us', sl: 'O nas' } };

  it('creates a page with an empty draft layout, shown to visitors only once published', async () => {
    const page = await store.pages.create(about);
    expect(page).toMatchObject({ ...about, descriptions: {}, publishedVersion: null });
    expect(await store.layouts.readNewest('about')).toMatchObject({ version: 1, status: 'draft', content: { sections: [] } });
    expect(await store.pages.readBySlug('about-us', true)).toMatchObject({ page: { pageKey: 'about' }, layout: { version: 1, isDraft: true } });
    expect(await store.pages.readBySlug('about-us', false)).toBeNull();
    store.setRole('visitor');
    expect(await store.pages.readBySlug('about-us', true)).toBeNull();
    store.setRole('editor');
    await store.layouts.publish('about', 1);
    store.setRole('visitor');
    expect(await store.pages.readBySlug('about-us', true)).toMatchObject({ page: { publishedVersion: 1 }, layout: { version: 1, isDraft: false } });
    expect(await store.pages.readBySlug('nowhere', true)).toBeNull();
    expect(store.changeLog().map((entry) => entry.action)).toContain('create_page');
  });

  it('refuses a taken slug, a page key a layout already has, a bad page and a caller who is not an editor', async () => {
    await store.pages.create(about);
    await store.layouts.saveDraft('home', { sections: [] }, [], null);
    expect(await rejects(store.pages.create({ ...about, pageKey: 'other' }))).toMatchObject({ name: 'PageTakenError', field: 'slug', value: 'about-us' });
    expect(await rejects(store.pages.create({ ...about, pageKey: 'home', slug: 'home-page' }))).toMatchObject({ name: 'PageTakenError', field: 'pageKey', value: 'home' });
    expect(await rejects(store.pages.create({ ...about, pageKey: 'x', slug: 'Bad Slug' }))).toBeInstanceOf(ContentValidationError);
    expect(await rejects(store.pages.create({ pageKey: 'x', slug: 'x', titles: { sl: 'Brez angleščine' } } as never))).toBeInstanceOf(ContentValidationError);
    store.setRole('member');
    expect(await rejects(store.pages.create({ ...about, pageKey: 'y', slug: 'y' }))).toBeInstanceOf(ContentPermissionError);
  });

  it('changes a page, keeping what is not given, and lists pages for editors only', async () => {
    await store.pages.create(about);
    await store.pages.create({ pageKey: 'news', slug: 'news', titles: { en: 'News' } });
    expect(await store.pages.update('about', { slug: 'who-we-are', descriptions: { en: 'Us' } })).toMatchObject({ slug: 'who-we-are', titles: about.titles, descriptions: { en: 'Us' } });
    expect(await rejects(store.pages.update('about', { slug: 'news' }))).toMatchObject({ name: 'PageTakenError', field: 'slug' });
    expect(await store.pages.update('about', { slug: 'who-we-are' })).toMatchObject({ slug: 'who-we-are' });
    expect(await rejects(store.pages.update('nope', { slug: 'x' }))).toBeInstanceOf(ContentNotFoundError);
    expect((await store.pages.list()).map((page) => page.slug)).toEqual(['news', 'who-we-are']);
    store.setRole('visitor');
    expect(await store.pages.list()).toEqual([]);
    expect(await rejects(store.pages.update('about', { slug: 'z' }))).toBeInstanceOf(ContentPermissionError);
  });
});
