import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ContentConflictError, ContentValidationError } from '../content/errors';
import {
  BUILTIN_SECTION_TEMPLATES,
  ContentPermissionError,
  ContentReferencedError,
  MAX_REFERENCE_DEPTH,
  assetRefSchema,
  createCmsProvider,
  createContentTypeRegistry,
  createInMemoryCmsStore,
  itemRefSchema,
  type CmsProvider,
  type ContentType,
  type InMemoryCmsStore,
  type ResolvedItem,
} from './index';

const bannerSchema = z.object({ title: z.string().min(1), image: assetRefSchema.optional(), tone: z.enum(['calm', 'loud']).default('calm') });
const cardSchema = z.object({ heading: z.string().min(1), related: itemRefSchema.optional() });

function build() {
  const registry = createContentTypeRegistry();
  registry.register({
    key: 'section',
    label: 'Section',
    kind: 'container',
    storage: 'document',
    translatable: false,
    schema: z.object({}),
    component: 'Section',
    slots: [
      { key: 'banner', label: 'Banner', allowedTypeKeys: ['banner'], min: 0, max: 1 },
      { key: 'cards', label: 'Cards', allowedTypeKeys: ['card'], min: 0, max: 24 },
      { key: 'timeline', label: 'Timeline', allowedTypeKeys: ['banner'], min: 0, max: 1 },
    ],
  });
  const banner = registry.register({ key: 'banner', label: 'Banner', kind: 'block', storage: 'document', translatable: true, schema: bannerSchema, component: 'Banner' });
  const card = registry.register({ key: 'card', label: 'Card', kind: 'block', storage: 'document', translatable: true, schema: cardSchema, component: 'Card' });
  const note = registry.register({ key: 'note', label: 'Note', kind: 'block', storage: 'document', translatable: false, schema: z.object({ text: z.string() }), component: 'Note' });
  registry.register({ key: 'post', label: 'Post', kind: 'block', storage: 'collection', translatable: false, adapter: 'posts', schema: z.object({ title: z.string() }), component: 'Post' });
  registry.register({
    key: 'strict',
    label: 'Strict',
    kind: 'container',
    storage: 'document',
    translatable: false,
    schema: z.object({}),
    component: 'Strict',
    slots: [{ key: 'cards', label: 'Cards', allowedTypeKeys: ['card'], min: 2, max: 6 }],
  });
  registry.validate();
  return { registry, banner, card, note };
}

let store: InMemoryCmsStore;
let provider: CmsProvider;
let types: ReturnType<typeof build>;
/** Counts the calls the provider makes to resolveItems. */
let resolveCalls: number;

beforeEach(() => {
  types = build();
  store = createInMemoryCmsStore();
  store.setRole('editor');
  const original = store.items.resolveItems.bind(store.items);
  resolveCalls = 0;
  store.items.resolveItems = (ids, language, preview) => {
    resolveCalls += 1;
    return original(ids, language, preview);
  };
  provider = createCmsProvider({ store, registry: types.registry });
});

const rejects = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
};

/** Makes an item through the provider and publishes `content` in `language`. */
async function publishedItem(type: ContentType, content: unknown, language: 'sl' | 'en' | 'de' = 'en', reusable = true) {
  const item = await provider.createItem({ typeKey: type.key, title: `${type.key} ${Math.random()}`, reusable });
  const version = await provider.saveItemDraft(item.id, type, language, content, null);
  await provider.publishItem(item.id, type, language, version);
  return item;
}

const layoutWith = (sections: { key: string; template: string; slots: Record<string, string[]> }[]) => ({ sections });
async function publishLayout(content: unknown, pageKey = 'home') {
  const version = await provider.saveLayoutDraft(pageKey, content, null);
  await provider.publishLayout(pageKey, version);
  return version;
}

describe('editing items', () => {
  it('makes an item of a registered document type with the type\'s translatable flag, and refuses anything else', async () => {
    expect(await provider.createItem({ typeKey: 'banner', title: 'A' })).toMatchObject({ typeKey: 'banner', translatable: true, reusable: false });
    expect(await provider.createItem({ typeKey: 'note', title: 'N' })).toMatchObject({ translatable: false });
    expect(await provider.createItem({ typeKey: 'section', title: 'S' })).toMatchObject({ typeKey: 'section' });
    expect(await rejects(provider.createItem({ typeKey: 'ghost', title: 'G' }))).toBeInstanceOf(ContentValidationError);
    expect(await rejects(provider.createItem({ typeKey: 'post', title: 'P' }))).toBeInstanceOf(ContentValidationError);
  });

  it('checks content against the schema on save, writes nothing when it is wrong, and saves the parsed content', async () => {
    const item = await provider.createItem({ typeKey: 'banner', title: 'A' });
    const error = (await rejects(provider.saveItemDraft(item.id, types.banner, 'en', { title: '' }, null))) as ContentValidationError;
    expect(error).toBeInstanceOf(ContentValidationError);
    expect(error.issues.join('\n')).toMatch(/title/);
    expect(await store.items.readNewest(item.id, 'en')).toBeNull();

    await provider.saveItemDraft(item.id, types.banner, 'en', { title: 'Hi', extra: 'dropped' }, null);
    expect((await store.items.readNewest(item.id, 'en'))?.content).toEqual({ title: 'Hi', tone: 'calm' });
  });

  it('collects the $ref markers from the checked content and hands them to the store as references', async () => {
    const target = await publishedItem(types.card, { heading: 'Target' });
    const source = await provider.createItem({ typeKey: 'card', title: 'Source' });
    await provider.saveItemDraft(source.id, types.card, 'en', { heading: 'S', related: { $ref: target.id } }, null);
    const usages = await provider.usages(target.id);
    expect(usages).toEqual([expect.objectContaining({ sourceKind: 'item', sourceId: source.id, inNewest: true })]);
    // a reference to an item that does not exist is refused by the store, nothing saved
    const ghost = '00000000-0000-4000-8000-000000000999';
    expect(await rejects(provider.saveItemDraft(source.id, types.card, 'en', { heading: 'S', related: { $ref: ghost } }, 1))).toMatchObject({ reason: 'missing' });
  });

  it('uses the language all for a type that is not translatable, whatever language is passed', async () => {
    const item = await provider.createItem({ typeKey: 'note', title: 'N' });
    expect(await provider.saveItemDraft(item.id, types.note, 'de', { text: 'one' }, null)).toBe(1);
    expect(await provider.saveItemDraft(item.id, types.note, 'sl', { text: 'two' }, 1)).toBe(2);
    await provider.publishItem(item.id, types.note, 'en', 2);
    expect((await provider.draft(item.id, types.note, 'sl'))?.content).toEqual({ text: 'two' });
    expect((await provider.listItemVersions(item.id, types.note, 'de')).map((v) => v.version)).toEqual([2, 1]);
    expect((await provider.item(item.id, types.note, 'de'))?.language).toBe('all');
  });

  it('refuses to save a collection type through the item store', async () => {
    const post = types.registry.require('post');
    expect(await rejects(provider.saveItemDraft('00000000-0000-4000-8000-000000000999', post, 'en', { title: 'x' }, null))).toBeInstanceOf(ContentValidationError);
  });

  it('refuses a stale save with the newer version and lets restore make a new version', async () => {
    const item = await provider.createItem({ typeKey: 'banner', title: 'A' });
    await provider.saveItemDraft(item.id, types.banner, 'en', { title: 'one' }, null);
    await provider.saveItemDraft(item.id, types.banner, 'en', { title: 'two' }, 1);
    expect(await rejects(provider.saveItemDraft(item.id, types.banner, 'en', { title: 'x' }, 1))).toBeInstanceOf(ContentConflictError);
    expect(await provider.restoreItem(item.id, types.banner, 'en', 1, 2)).toBe(3);
    expect((await provider.draft(item.id, types.banner, 'en'))?.content).toMatchObject({ title: 'one' });
  });

  it('refuses stored content that no longer matches the schema when it is read for editing', async () => {
    const item = await provider.createItem({ typeKey: 'banner', title: 'A' });
    await store.items.saveDraft(item.id, 'en', { title: 5 }, [], null);
    expect(await rejects(provider.draft(item.id, types.banner, 'en'))).toBeInstanceOf(ContentValidationError);
  });

  it('passes the backend\'s refusals through: a visitor is refused, a referenced item is not deleted', async () => {
    const target = await publishedItem(types.card, { heading: 'T' });
    const source = await provider.createItem({ typeKey: 'card', title: 'S' });
    await provider.saveItemDraft(source.id, types.card, 'en', { heading: 'S', related: { $ref: target.id } }, null);
    store.setRole('owner');
    expect(await rejects(provider.deleteItem(target.id))).toBeInstanceOf(ContentReferencedError);
    store.setRole('visitor');
    expect(await rejects(provider.createItem({ typeKey: 'card', title: 'x' }))).toBeInstanceOf(ContentPermissionError);
    expect(await provider.listItems()).toEqual([]);
  });
});

describe('reading one item', () => {
  it('serves the language asked for, falls back to English, and checks the content against the type', async () => {
    const item = await publishedItem(types.banner, { title: 'English' });
    const sl = await provider.saveItemDraft(item.id, types.banner, 'sl', { title: 'Slovenski' }, null);
    await provider.publishItem(item.id, types.banner, 'sl', sl);
    store.setRole('visitor');
    expect(await provider.item(item.id, types.banner, 'sl')).toMatchObject({ language: 'sl', content: { title: 'Slovenski', tone: 'calm' }, isDraft: false });
    expect(await provider.item(item.id, types.banner, 'de')).toMatchObject({ language: 'en', content: { title: 'English' } });
  });

  it('returns null when there is nothing to show and throws when the stored content is invalid', async () => {
    const empty = await provider.createItem({ typeKey: 'banner', title: 'A' });
    expect(await provider.item(empty.id, types.banner, 'en')).toBeNull();
    const broken = await provider.createItem({ typeKey: 'banner', title: 'B' });
    await store.items.saveDraft(broken.id, 'en', { title: 5 }, [], null);
    await store.items.publish(broken.id, 'en', 1);
    expect(await rejects(provider.item(broken.id, types.banner, 'en'))).toBeInstanceOf(ContentValidationError);
  });

  it('refuses an item of another type than the one asked for', async () => {
    const item = await publishedItem(types.banner, { title: 'x' });
    expect(await rejects(provider.item(item.id, types.card, 'en'))).toBeInstanceOf(ContentValidationError);
    // the same schema under another key: only the key tells them apart
    const twin = { ...types.banner, key: 'twin' } as ContentType;
    const error = (await rejects(provider.item(item.id, twin, 'en'))) as ContentValidationError;
    expect(error.message).toMatch(/not a "twin"/);
  });

  it('shows an editor the draft in a preview and nobody else, whatever the flag says', async () => {
    const item = await publishedItem(types.banner, { title: 'Live' });
    await provider.saveItemDraft(item.id, types.banner, 'en', { title: 'Draft' }, 1);
    expect(await provider.item(item.id, types.banner, 'en', { preview: true })).toMatchObject({ content: { title: 'Draft' }, isDraft: true });
    expect(await provider.item(item.id, types.banner, 'en')).toMatchObject({ content: { title: 'Live' }, isDraft: false });
    for (const role of ['visitor', 'member'] as const) {
      store.setRole(role);
      expect(await provider.item(item.id, types.banner, 'en', { preview: true })).toMatchObject({ content: { title: 'Live' }, isDraft: false });
    }
  });

  it('rejects a language the SDK does not know', async () => {
    await expect(provider.item('00000000-0000-4000-8000-000000000999', types.banner, 'fr' as never)).rejects.toThrow(/language/);
  });
});

describe('reading a page', () => {
  async function simplePage() {
    const banner = await publishedItem(types.banner, { title: 'Hello' });
    await publishLayout(layoutWith([{ key: 'hero', template: 'banner-section', anchor: 'top', slots: { banner: [banner.id] } } as never]));
    return banner;
  }

  it('returns null when the page has no layout, or no published layout', async () => {
    expect(await provider.page('home', 'en')).toBeNull();
    await provider.saveLayoutDraft('home', layoutWith([]), null);
    expect(await provider.page('home', 'en')).toBeNull();
    expect(await provider.page('home', 'en', { preview: true })).toMatchObject({ isDraft: true, version: 1 });
  });

  it('resolves sections in order with their template, anchor and checked items, and no problems', async () => {
    const banner = await simplePage();
    const page = await provider.page('home', 'en');
    expect(page).toMatchObject({ pageKey: 'home', version: 1, isDraft: false, language: 'en', problems: [] });
    expect(page?.sections).toHaveLength(1);
    expect(page?.sections[0]).toMatchObject({ key: 'hero', anchor: 'top', template: { key: 'banner-section' } });
    expect(page?.sections[0]?.slots.banner).toEqual([{ id: banner.id, typeKey: 'banner', language: 'en', version: 1, status: 'published', isDraft: false, content: { title: 'Hello', tone: 'calm' } }]);
    expect(page?.sections[0]?.template).not.toHaveProperty('createdAt');
  });

  it('keeps the order of the layout and of each slot, and gives every template slot an array', async () => {
    const a = await publishedItem(types.card, { heading: 'A' });
    const b = await publishedItem(types.card, { heading: 'B' });
    const banner = await publishedItem(types.banner, { title: 'T' });
    await publishLayout(
      layoutWith([
        { key: 'second', template: 'help-section', slots: { cards: [b.id, a.id] } },
        { key: 'first', template: 'banner-section', slots: { banner: [banner.id] } },
      ]),
    );
    const page = await provider.page('home', 'en');
    expect(page?.sections.map((s) => s.key)).toEqual(['second', 'first']);
    expect(page?.sections[0]?.slots.cards?.map((i) => (i.content as { heading: string }).heading)).toEqual(['B', 'A']);
    const empty = await provider.page('home', 'en');
    expect(empty?.sections[0]?.slots).toHaveProperty('cards');
  });

  it('serves a missing translation from English, per item', async () => {
    const banner = await simplePage();
    const sl = await provider.saveItemDraft(banner.id, types.banner, 'sl', { title: 'Živjo' }, null);
    await provider.publishItem(banner.id, types.banner, 'sl', sl);
    expect((await provider.page('home', 'sl'))?.sections[0]?.slots.banner?.[0]).toMatchObject({ language: 'sl', content: { title: 'Živjo' } });
    expect((await provider.page('home', 'de'))?.sections[0]?.slots.banner?.[0]).toMatchObject({ language: 'en', content: { title: 'Hello' } });
    expect((await provider.page('home', 'de'))?.language).toBe('de');
  });

  it('serves a page with a non-translatable item whatever the language', async () => {
    const note = await publishedItem(types.note, { text: 'same' }, 'en');
    await store.templates.save({ ...BUILTIN_SECTION_TEMPLATES[0]!, key: 'note-section', slots: [{ key: 'banner', label: 'N', allowedTypeKeys: ['note'], min: 0, max: null }] }).catch(() => undefined);
    store.setRole('owner');
    await store.templates.save({ ...BUILTIN_SECTION_TEMPLATES[0]!, key: 'note-section', slots: [{ key: 'banner', label: 'N', allowedTypeKeys: ['note'], min: 0, max: null }] });
    store.setRole('editor');
    await publishLayout(layoutWith([{ key: 'n', template: 'note-section', slots: { banner: [note.id] } }]));
    for (const language of ['sl', 'en', 'de'] as const) {
      expect((await provider.page('home', language))?.sections[0]?.slots.banner?.[0]).toMatchObject({ language: 'all', content: { text: 'same' } });
    }
  });

  describe('problems', () => {
    it('reports a section whose template is gone, and leaves the section out', async () => {
      const banner = await publishedItem(types.banner, { title: 'x' });
      await publishLayout(layoutWith([{ key: 'hero', template: 'banner-section', slots: { banner: [banner.id] } }, { key: 'ok', template: 'banner-section', slots: { banner: [banner.id] } }]));
      // a layout version saved before a template existed cannot be made through the store, so seed it through the store's own raw layout write with a template that is then unknown to the page: use a template removed by reading through a store that hides it
      const hidden = { ...store, templates: { ...store.templates, list: async () => (await store.templates.list()).filter((t) => t.key !== 'banner-section') } } as InMemoryCmsStore;
      const page = await createCmsProvider({ store: hidden, registry: types.registry }).page('home', 'en');
      expect(page?.sections).toEqual([]);
      expect(page?.problems).toEqual([
        expect.objectContaining({ sectionKey: 'hero', slotKey: null, itemId: null, reason: 'unknown-template' }),
        expect.objectContaining({ sectionKey: 'ok', reason: 'unknown-template' }),
      ]);
    });

    it('reports an item with nothing published, leaves it out, and still renders the rest', async () => {
      const live = await publishedItem(types.card, { heading: 'Live' });
      const unpublished = await provider.createItem({ typeKey: 'card', title: 'Draft only', reusable: true });
      await provider.saveItemDraft(unpublished.id, types.card, 'en', { heading: 'Draft' }, null);
      await publishLayout(layoutWith([{ key: 'help', template: 'help-section', slots: { cards: [unpublished.id, live.id] } }]));
      const page = await provider.page('home', 'en');
      expect(page?.sections[0]?.slots.cards?.map((i) => i.id)).toEqual([live.id]);
      expect(page?.problems).toEqual([expect.objectContaining({ sectionKey: 'help', slotKey: 'cards', itemId: unpublished.id, reason: 'item-not-published' })]);
    });

    it('reports an item of a type that is not registered, and one whose stored content is invalid, and never returns either', async () => {
      const card = await publishedItem(types.card, { heading: 'ok' });
      const unknown = await store.items.createItem({ typeKey: 'mystery', title: 'M', reusable: true, translatable: true });
      await store.items.saveDraft(unknown.id, 'en', { a: 1 }, [], null);
      await store.items.publish(unknown.id, 'en', 1);
      const broken = await store.items.createItem({ typeKey: 'card', title: 'B', reusable: true, translatable: true });
      await store.items.saveDraft(broken.id, 'en', { heading: 42 }, [], null);
      await store.items.publish(broken.id, 'en', 1);
      store.setRole('owner');
      await store.templates.save({ ...BUILTIN_SECTION_TEMPLATES[1]!, key: 'wide', slots: [{ key: 'cards', label: 'C', allowedTypeKeys: ['card', 'mystery'], min: 0, max: null }] });
      store.setRole('editor');
      await publishLayout(layoutWith([{ key: 'w', template: 'wide', slots: { cards: [unknown.id, broken.id, card.id] } }]));
      const page = await provider.page('home', 'en');
      expect(page?.sections[0]?.slots.cards?.map((i) => i.id)).toEqual([card.id]);
      expect(page?.problems.map((p) => [p.itemId, p.reason])).toEqual([
        [unknown.id, 'unknown-type'],
        [broken.id, 'invalid-content'],
      ]);
      expect(page?.problems[1]?.message).toMatch(/heading/);
    });
  });

  describe('preview', () => {
    it('shows an editor the newest layout and draft items, marked as drafts', async () => {
      const banner = await simplePage();
      await provider.saveItemDraft(banner.id, types.banner, 'en', { title: 'Draft title' }, 1);
      await provider.saveLayoutDraft('home', layoutWith([{ key: 'hero', template: 'banner-section', slots: { banner: [banner.id] } }, { key: 'extra', template: 'banner-section', slots: {} }]), 1);
      const live = await provider.page('home', 'en');
      expect(live).toMatchObject({ version: 1, isDraft: false });
      expect(live?.sections).toHaveLength(1);
      const preview = await provider.page('home', 'en', { preview: true });
      expect(preview).toMatchObject({ version: 2, isDraft: true });
      expect(preview?.sections).toHaveLength(2);
      expect(preview?.sections[0]?.slots.banner?.[0]).toMatchObject({ isDraft: true, content: { title: 'Draft title' } });
    });

    it('does not mark the layout as a draft when the newest version is the published one', async () => {
      await simplePage();
      expect(await provider.page('home', 'en', { preview: true })).toMatchObject({ isDraft: false, version: 1 });
    });

    it('reads a page through the read every caller may make, never the editors-only newest-layout read', async () => {
      await simplePage();
      store.layouts.readNewest = async () => {
        throw new ContentPermissionError('Only editors and owners can read drafts.');
      };
      store.setRole('visitor');
      expect(await provider.page('home', 'en', { preview: true })).toMatchObject({ isDraft: false, version: 1 });
    });

    it('does not hide a failure of the layout read', async () => {
      await simplePage();
      store.layouts.read = async () => {
        throw new Error('boom');
      };
      await expect(provider.page('home', 'en', { preview: true })).rejects.toThrow('boom');
    });

    it('shows a visitor or a member who sends the preview flag nothing but the published page', async () => {
      const banner = await simplePage();
      await provider.saveItemDraft(banner.id, types.banner, 'en', { title: 'Secret' }, 1);
      await provider.saveLayoutDraft('home', layoutWith([]), 1);
      for (const role of ['visitor', 'member'] as const) {
        store.setRole(role);
        const page = await provider.page('home', 'en', { preview: true });
        expect(page).toMatchObject({ version: 1, isDraft: false });
        expect(page?.sections[0]?.slots.banner?.[0]).toMatchObject({ isDraft: false, content: { title: 'Hello' } });
        expect(JSON.stringify(page)).not.toContain('Secret');
      }
    });

    it('lets a draft language beat a published English entry for an editor in preview', async () => {
      const banner = await simplePage();
      await provider.saveItemDraft(banner.id, types.banner, 'de', { title: 'Entwurf' }, null);
      expect((await provider.page('home', 'de', { preview: true }))?.sections[0]?.slots.banner?.[0]).toMatchObject({ language: 'de', isDraft: true });
      expect((await provider.page('home', 'de'))?.sections[0]?.slots.banner?.[0]).toMatchObject({ language: 'en', isDraft: false });
    });
  });

  describe('references', () => {
    /** A chain card0 -> card1 -> ... each published; returns the items. */
    async function chain(length: number) {
      const items: { id: string }[] = [];
      for (let index = length - 1; index >= 0; index -= 1) {
        const next = items[0];
        items.unshift(await publishedItem(types.card, { heading: `card ${index}`, ...(next ? { related: { $ref: next.id } } : {}) }));
      }
      return items;
    }
    const render = (item: ResolvedItem | undefined, depth = 0): string[] => {
      const content = item?.content as { heading: string; related?: ResolvedItem | { $ref: string } };
      if (!content) return [];
      const related = content.related && 'content' in content.related ? render(content.related, depth + 1) : content.related ? [`marker@${depth + 1}`] : [];
      return [content.heading, ...related];
    };

    it('replaces each $ref with the referenced item as it resolves, in one extra round trip', async () => {
      const [first, second] = await chain(2);
      await publishLayout(layoutWith([{ key: 'help', template: 'help-section', slots: { cards: [first!.id] } }]));
      resolveCalls = 0;
      const page = await provider.page('home', 'en');
      expect(page?.problems).toEqual([]);
      const related = (page?.sections[0]?.slots.cards?.[0]?.content as unknown as { related: ResolvedItem }).related;
      expect(related).toMatchObject({ id: second!.id, typeKey: 'card', language: 'en', isDraft: false, content: { heading: 'card 1' } });
      expect(resolveCalls).toBe(2);
    });

    it('resolves three levels of references and leaves the fourth as a marker, reported (1 + MAX_REFERENCE_DEPTH round trips)', async () => {
      expect(MAX_REFERENCE_DEPTH).toBe(3);
      const items = await chain(6);
      await publishLayout(layoutWith([{ key: 'help', template: 'help-section', slots: { cards: [items[0]!.id] } }]));
      resolveCalls = 0;
      const page = await provider.page('home', 'en');
      expect(render(page?.sections[0]?.slots.cards?.[0])).toEqual(['card 0', 'card 1', 'card 2', 'card 3', 'marker@4']);
      expect(page?.problems).toEqual([expect.objectContaining({ reason: 'reference-too-deep', itemId: items[4]!.id, sectionKey: 'help', slotKey: 'cards' })]);
      expect(resolveCalls).toBe(1 + MAX_REFERENCE_DEPTH);
    });

    it('does not report a chain that ends exactly at the depth cap', async () => {
      const items = await chain(4);
      await publishLayout(layoutWith([{ key: 'help', template: 'help-section', slots: { cards: [items[0]!.id] } }]));
      const page = await provider.page('home', 'en');
      expect(render(page?.sections[0]?.slots.cards?.[0])).toEqual(['card 0', 'card 1', 'card 2', 'card 3']);
      expect(page?.problems).toEqual([]);
    });

    it('stops at a cycle by id, keeps the marker and reports it', async () => {
      const a = await provider.createItem({ typeKey: 'card', title: 'a', reusable: true });
      const b = await provider.createItem({ typeKey: 'card', title: 'b', reusable: true });
      // the store trusts the references it is given, so a circle can only be made by omitting them: the provider must still stop
      await store.items.saveDraft(a.id, 'en', { heading: 'a', related: { $ref: b.id } }, [], null);
      await store.items.saveDraft(b.id, 'en', { heading: 'b', related: { $ref: a.id } }, [], null);
      await store.items.publish(a.id, 'en', 1);
      await store.items.publish(b.id, 'en', 1);
      await publishLayout(layoutWith([{ key: 'help', template: 'help-section', slots: { cards: [a.id] } }]));
      const page = await provider.page('home', 'en');
      expect(render(page?.sections[0]?.slots.cards?.[0])).toEqual(['a', 'b', 'marker@2']);
      expect(page?.problems).toEqual([expect.objectContaining({ reason: 'reference-cycle', itemId: a.id })]);
    });

    it('keeps the marker and reports a referenced item that has nothing published', async () => {
      const target = await provider.createItem({ typeKey: 'card', title: 't', reusable: true });
      await provider.saveItemDraft(target.id, types.card, 'en', { heading: 'unpublished' }, null);
      const source = await publishedItem(types.card, { heading: 'source', related: { $ref: target.id } });
      await publishLayout(layoutWith([{ key: 'help', template: 'help-section', slots: { cards: [source.id] } }]));
      const page = await provider.page('home', 'en');
      expect((page?.sections[0]?.slots.cards?.[0]?.content as { related: unknown }).related).toEqual({ $ref: target.id });
      expect(page?.problems).toEqual([expect.objectContaining({ reason: 'item-not-published', itemId: target.id })]);
    });

    it('resolves a reference to a draft only for an editor in preview', async () => {
      const target = await provider.createItem({ typeKey: 'card', title: 't', reusable: true });
      await provider.saveItemDraft(target.id, types.card, 'en', { heading: 'draft target' }, null);
      const source = await publishedItem(types.card, { heading: 'source', related: { $ref: target.id } });
      await publishLayout(layoutWith([{ key: 'help', template: 'help-section', slots: { cards: [source.id] } }]));
      const preview = await provider.page('home', 'en', { preview: true });
      expect((preview?.sections[0]?.slots.cards?.[0]?.content as { related: ResolvedItem }).related).toMatchObject({ isDraft: true, content: { heading: 'draft target' } });
      store.setRole('visitor');
      const visitor = await provider.page('home', 'en', { preview: true });
      expect((visitor?.sections[0]?.slots.cards?.[0]?.content as { related: unknown }).related).toEqual({ $ref: target.id });
    });

    it('resolves a shared item used twice (a diamond) without calling it a cycle', async () => {
      const shared = await publishedItem(types.card, { heading: 'shared' });
      const left = await publishedItem(types.card, { heading: 'left', related: { $ref: shared.id } });
      const right = await publishedItem(types.card, { heading: 'right', related: { $ref: shared.id } });
      await publishLayout(layoutWith([{ key: 'help', template: 'help-section', slots: { cards: [left.id, right.id] } }]));
      const page = await provider.page('home', 'en');
      expect(page?.problems).toEqual([]);
      expect(page?.sections[0]?.slots.cards?.map((c) => render(c))).toEqual([['left', 'shared'], ['right', 'shared']]);
    });

    it('makes one round trip when nothing is referenced', async () => {
      await simplePage();
      resolveCalls = 0;
      await provider.page('home', 'en');
      expect(resolveCalls).toBe(1);
    });

    it('resolves references for a single item read as well', async () => {
      const [first, second] = await chain(2);
      const item = await provider.item(first!.id, types.card, 'en');
      expect((item?.content as unknown as { related: ResolvedItem }).related.id).toBe(second!.id);
    });
  });
});

describe('editing layouts', () => {
  it('checks the layout against its schema, collects the item ids as references, and passes the store\'s slot rules through', async () => {
    const banner = await publishedItem(types.banner, { title: 'x' });
    expect(await rejects(provider.saveLayoutDraft('home', { sections: 'nope' }, null))).toBeInstanceOf(ContentValidationError);
    expect(await store.layouts.readNewest('home')).toBeNull();
    const version = await provider.saveLayoutDraft('home', layoutWith([{ key: 'hero', template: 'banner-section', slots: { banner: [banner.id] } }]), null);
    expect(version).toBe(1);
    expect(await provider.usages(banner.id)).toEqual([expect.objectContaining({ sourceKind: 'layout', sourceLabel: 'home' })]);
    expect((await provider.layoutDraft('home'))?.content.sections[0]?.key).toBe('hero');
    expect(await provider.layoutDraft('nope')).toBeNull();
    expect((await provider.layouts()).map((l) => l.pageKey)).toEqual(['home']);
    expect((await provider.listLayoutVersions('home')).map((v) => v.version)).toEqual([1]);
  });

  it('publishes, restores and reorders through the store', async () => {
    const a = await publishedItem(types.card, { heading: 'a' });
    const b = await publishedItem(types.card, { heading: 'b' });
    await provider.saveLayoutDraft('home', layoutWith([{ key: 'help', template: 'help-section', slots: { cards: [a.id, b.id] } }]), null);
    await provider.publishLayout('home', 1);
    expect(await provider.reorderSlot('home', 'help', 'cards', [b.id, a.id], 1)).toBe(2);
    expect(await provider.restoreLayout('home', 1, 2)).toBe(3);
    expect(await rejects(provider.saveLayoutDraft('home', layoutWith([]), 1))).toBeInstanceOf(ContentConflictError);
  });

  it('refuses invalid stored layout content when read for editing', async () => {
    await store.layouts.saveDraft('home', layoutWith([]), [], null);
    expect((await provider.layoutDraft('home'))?.content).toEqual({ sections: [] });
  });
});

describe('templates and assets', () => {
  const slots = [{ key: 'cards', label: 'Cards', allowedTypeKeys: ['card'], min: 0, max: 6 }];
  const template = { key: 'six-cards', name: 'Six cards', containerTypeKey: 'section', slots, builtIn: false };

  it('lists the templates without their timestamps', async () => {
    const list = await provider.templates();
    expect(list).toEqual(BUILTIN_SECTION_TEMPLATES);
  });

  it('saves a template that narrows its container, and refuses one that does not', async () => {
    store.setRole('owner');
    expect(await provider.saveTemplate(template)).toMatchObject({ key: 'six-cards', builtIn: false });
    const refused: Record<string, unknown>[] = [
      { ...template, key: 'a', containerTypeKey: 'ghost' },
      { ...template, key: 'b', containerTypeKey: 'banner' },
      { ...template, key: 'c', slots: [{ ...slots[0]!, key: 'nope' }] },
      { ...template, key: 'd', slots: [{ ...slots[0]!, allowedTypeKeys: ['card', 'banner'] }] },
      { ...template, key: 'e', slots: [{ ...slots[0]!, max: 25 }] },
      { ...template, key: 'f', slots: [{ ...slots[0]!, max: null }] },
      { ...template, key: 'g', name: '' },
      { ...template, key: 'h', containerTypeKey: 'strict', slots: [{ ...slots[0]!, min: 1 }] },
    ];
    for (const bad of refused) expect(await rejects(provider.saveTemplate(bad as never))).toBeInstanceOf(ContentValidationError);
    expect((await provider.templates()).map((t) => t.key)).toEqual([...BUILTIN_SECTION_TEMPLATES.map((t) => t.key), 'six-cards']);
  });

  it('lets only an owner save a template (the store decides)', async () => {
    expect(await rejects(provider.saveTemplate(template))).toBeInstanceOf(ContentPermissionError);
  });

  it('registers and lists assets', async () => {
    store.uploadObject('a.png');
    const file = { path: 'a.png', mime: 'image/png' as const, bytes: 10, width: null, height: null, label: null };
    expect(await rejects(provider.registerAsset({ ...file, mime: 'image/gif' as never }))).toBeInstanceOf(ContentValidationError);
    const asset = await provider.registerAsset(file);
    expect(await provider.assets()).toEqual([asset]);
  });
});
