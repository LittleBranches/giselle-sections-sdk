import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createContentProvider } from './content-provider';
import { ContentConflictError, ContentValidationError } from './errors';
import { defineSection } from './section';
import { createInMemoryContentStore } from './store';

const sources = defineSection({
  key: 'sources',
  languages: ['sl', 'en', 'de'],
  schema: z.object({ items: z.array(z.object({ label: z.string().min(1), href: z.url() })) }),
});

const good = { items: [{ label: 'Daily', href: 'https://example.test/a' }] };
const other = { items: [{ label: 'Other', href: 'https://example.test/b' }] };

const setup = () => {
  const store = createInMemoryContentStore();
  return { store, provider: createContentProvider(store) };
};

describe('defineSection', () => {
  it('returns the section as declared', () => {
    expect(sources.key).toBe('sources');
    expect(sources.languages).toEqual(['sl', 'en', 'de']);
  });
  it.each(['Sources', '1st', 'has space', ''])('rejects the key "%s"', (key) => {
    expect(() => defineSection({ key, languages: ['sl'], schema: z.object({}) })).toThrow();
  });
  it('rejects a section with no language', () => {
    expect(() => defineSection({ key: 'x', languages: [], schema: z.object({}) })).toThrow(/language/);
  });
});

describe('saving, publishing and reading', () => {
  it('shows nothing before anything is published, even when a draft exists', async () => {
    const { provider } = setup();
    await provider.saveDraft(sources, 'sl', good, null);
    expect(await provider.published(sources, 'sl')).toBeNull();
  });

  it('shows the published version after publish, and a later draft stays unseen', async () => {
    const { provider } = setup();
    const v1 = await provider.saveDraft(sources, 'sl', good, null);
    await provider.publish(sources, 'sl', v1);
    expect((await provider.published(sources, 'sl'))?.content).toEqual(good);

    const v2 = await provider.saveDraft(sources, 'sl', other, v1);
    expect(v2).toBe(2);
    expect((await provider.published(sources, 'sl'))?.content).toEqual(good);
    expect((await provider.draft(sources, 'sl'))?.content).toEqual(other);

    await provider.publish(sources, 'sl', v2);
    expect((await provider.published(sources, 'sl'))?.content).toEqual(other);
  });

  it('falls back to Slovenian when the language has no published entry, and says so', async () => {
    const { provider } = setup();
    await provider.publish(sources, 'sl', await provider.saveDraft(sources, 'sl', good, null));
    await provider.saveDraft(sources, 'en', other, null); // a draft is not a published entry
    const served = await provider.published(sources, 'en');
    expect(served?.content).toEqual(good);
    expect(served?.language).toBe('sl');
  });

  it('serves a language its own entry once published', async () => {
    const { provider } = setup();
    await provider.publish(sources, 'sl', await provider.saveDraft(sources, 'sl', good, null));
    await provider.publish(sources, 'de', await provider.saveDraft(sources, 'de', other, null));
    const served = await provider.published(sources, 'de');
    expect(served?.content).toEqual(other);
    expect(served?.language).toBe('de');
  });

  it('returns null when neither the language nor Slovenian is published', async () => {
    expect(await setup().provider.published(sources, 'en')).toBeNull();
  });

  it('rejects a language the section does not have', async () => {
    const onlySl = defineSection({ key: 'only-sl', languages: ['sl'], schema: z.object({}) });
    await expect(setup().provider.published(onlySl, 'en')).rejects.toThrow(/no en version/);
  });
});

describe('validation', () => {
  it('rejects invalid content on save, naming the field, and writes nothing', async () => {
    const { provider } = setup();
    const error = await provider.saveDraft(sources, 'sl', { items: [{ label: '', href: 'not a link' }] }, null).catch((e) => e);
    expect(error).toBeInstanceOf(ContentValidationError);
    expect(error.issues.some((line: string) => line.startsWith('items.0.href'))).toBe(true);
    expect(await provider.listVersions(sources, 'sl')).toEqual([]);
  });

  it('rejects invalid stored content on read instead of returning it', async () => {
    const { store, provider } = setup();
    const v = await store.saveDraft('sources', 'sl', { items: 'broken' }, null); // bypasses the provider
    await store.publish('sources', 'sl', v);
    await expect(provider.published(sources, 'sl')).rejects.toBeInstanceOf(ContentValidationError);
    await expect(provider.draft(sources, 'sl')).rejects.toBeInstanceOf(ContentValidationError);
  });
});

describe('a stale save', () => {
  it('is rejected with the newer version, and nothing is overwritten', async () => {
    const { provider } = setup();
    const v1 = await provider.saveDraft(sources, 'sl', good, null);
    await provider.saveDraft(sources, 'sl', other, v1); // someone else saves version 2

    const error = await provider.saveDraft(sources, 'sl', good, v1).catch((e) => e);
    expect(error).toBeInstanceOf(ContentConflictError);
    expect(error.current.version).toBe(2);
    expect(error.current.content).toEqual(other);
    expect(error.message).toMatch(/version 2/);
    expect((await provider.listVersions(sources, 'sl')).map((v) => v.version)).toEqual([2, 1]);
    expect((await provider.draft(sources, 'sl'))?.content).toEqual(other);
  });

  it('is rejected when saving a first version over an existing entry', async () => {
    const { provider } = setup();
    await provider.saveDraft(sources, 'sl', good, null);
    await expect(provider.saveDraft(sources, 'sl', other, null)).rejects.toBeInstanceOf(ContentConflictError);
  });

  it('is rejected when publishing a version that is no longer the newest', async () => {
    const { provider } = setup();
    const v1 = await provider.saveDraft(sources, 'sl', good, null);
    await provider.saveDraft(sources, 'sl', other, v1);
    await expect(provider.publish(sources, 'sl', v1)).rejects.toBeInstanceOf(ContentConflictError);
    expect(await provider.published(sources, 'sl')).toBeNull();
  });
});

describe('restoring', () => {
  it('saves the old content as a new version and leaves the old one alone', async () => {
    const { provider } = setup();
    const v1 = await provider.saveDraft(sources, 'sl', good, null);
    const v2 = await provider.saveDraft(sources, 'sl', other, v1);
    const v3 = await provider.restore(sources, 'sl', v1, v2);
    expect(v3).toBe(3);
    expect((await provider.draft(sources, 'sl'))?.content).toEqual(good);
    const versions = await provider.listVersions(sources, 'sl');
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(versions[0]?.restoredFrom).toBe(1);
  });

  it('is rejected, writing nothing, when it is based on a stale version', async () => {
    const { provider } = setup();
    const v1 = await provider.saveDraft(sources, 'sl', good, null);
    await provider.saveDraft(sources, 'sl', other, v1);
    await expect(provider.restore(sources, 'sl', v1, v1)).rejects.toBeInstanceOf(ContentConflictError);
    expect(await provider.listVersions(sources, 'sl')).toHaveLength(2);
  });
});
