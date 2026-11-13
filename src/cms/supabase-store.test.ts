import { describe, expect, it } from 'vitest';

import { ContentConflictError, ContentValidationError } from '../content/errors';
import {
  CMS_ERROR_CODES,
  ContentNotFoundError,
  ContentPermissionError,
  ContentReferenceError,
  ContentReferencedError,
  LayoutRuleError,
  createSupabaseCmsStore,
  type CmsSupabaseClient,
} from './index';

type Reply = { data?: unknown; error?: { code?: string; message?: string; details?: string | null; hint?: string | null } | null };

/** A fake that mimics what the client returns for an RPC and for a table read, and records every call. */
function fakeClient(replies: Record<string, Reply | ((args: Record<string, unknown> | undefined) => Reply)> = {}) {
  const calls: { fn: string; args: Record<string, unknown> | undefined }[] = [];
  const reads: { table: string; columns: string; filters: [string, unknown][] }[] = [];
  const client: CmsSupabaseClient = {
    rpc(fn, args) {
      calls.push({ fn, args });
      const reply = replies[fn];
      const resolved = typeof reply === 'function' ? reply(args) : (reply ?? {});
      return Promise.resolve({ data: resolved.data ?? null, error: resolved.error ?? null });
    },
    from(table) {
      const read = { table, columns: '', filters: [] as [string, unknown][] };
      reads.push(read);
      const reply = replies[`table:${table}`] as Reply | undefined;
      const result = () => ({ data: reply?.data ?? [], error: reply?.error ?? null });
      const query = {
        select(columns: string) {
          read.columns = columns;
          return builder;
        },
      };
      const builder = {
        eq(column: string, value: unknown) {
          read.filters.push([column, value]);
          return builder;
        },
        maybeSingle: () => Promise.resolve({ data: Array.isArray(result().data) ? ((result().data as unknown[])[0] ?? null) : result().data, error: result().error }),
        then: (onfulfilled: (value: ReturnType<typeof result>) => unknown, onrejected?: (reason: unknown) => unknown) => Promise.resolve(result()).then(onfulfilled, onrejected),
      };
      return query as never;
    },
  };
  return { client, calls, reads, store: createSupabaseCmsStore(client) };
}

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const rejects = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
};
const at = '2026-11-14T10:00:00Z';

describe('items: calls exactly the section 4 functions and maps their rows', () => {
  it('createItem and updateItem', async () => {
    const row = { id: id(1), type_key: 'card', title: 'T', reusable: true, translatable: false, created_at: at };
    const { store, calls } = fakeClient({ cms_create_item: { data: row }, cms_update_item: { data: [row] } });
    const item = await store.items.createItem({ typeKey: 'card', title: 'T', reusable: true, translatable: false });
    expect(item).toEqual({ id: id(1), typeKey: 'card', title: 'T', reusable: true, translatable: false, createdAt: at });
    await store.items.updateItem(id(1), { title: 'N' });
    await store.items.updateItem(id(1), { reusable: false });
    expect(calls).toEqual([
      { fn: 'cms_create_item', args: { p_type_key: 'card', p_title: 'T', p_reusable: true, p_translatable: false } },
      { fn: 'cms_update_item', args: { p_item_id: id(1), p_title: 'N', p_reusable: null } },
      { fn: 'cms_update_item', args: { p_item_id: id(1), p_title: null, p_reusable: false } },
    ]);
  });

  it('listItems maps the summary and passes the type filter', async () => {
    const { store, calls } = fakeClient({
      cms_list_items: { data: [{ id: id(1), type_key: 'card', title: 'T', reusable: true, translatable: true, created_at: at, published_languages: ['en', 'sl'], usage_count: 3 }] },
    });
    expect(await store.items.listItems({ typeKey: 'card' })).toEqual([
      { id: id(1), typeKey: 'card', title: 'T', reusable: true, translatable: true, createdAt: at, publishedLanguages: ['en', 'sl'], usageCount: 3 },
    ]);
    await store.items.listItems();
    expect(calls.map((c) => c.args)).toEqual([{ p_type_key: 'card' }, { p_type_key: null }]);
  });

  it('reads: published (no content owner columns), newest, versions', async () => {
    const { store, calls } = fakeClient({
      cms_read_published: { data: [{ version: 2, status: 'published', content: { a: 1 }, changed_at: at, restored_from: null }] },
      cms_read_newest: { data: [{ version: 3, status: 'draft', content: { a: 2 }, changed_by: id(9), changed_by_email: 'e@example.test', changed_at: at, restored_from: 1 }] },
      cms_list_versions: { data: [{ version: 3, status: 'draft', changed_by: null, changed_by_email: null, changed_at: at, restored_from: null }] },
    });
    expect(await store.items.readPublished(id(1), 'en')).toEqual({ itemId: id(1), language: 'en', version: 2, status: 'published', content: { a: 1 }, changedBy: null, changedByEmail: null, changedAt: at, restoredFrom: null });
    expect(await store.items.readNewest(id(1), 'de')).toMatchObject({ version: 3, changedBy: id(9), changedByEmail: 'e@example.test', restoredFrom: 1, language: 'de' });
    const versions = await store.items.listVersions(id(1), 'all');
    expect(versions[0]).toEqual({ itemId: id(1), language: 'all', version: 3, status: 'draft', changedBy: null, changedByEmail: null, changedAt: at, restoredFrom: null });
    expect(versions[0]).not.toHaveProperty('content');
    expect(calls).toEqual([
      { fn: 'cms_read_published', args: { p_item_id: id(1), p_language: 'en' } },
      { fn: 'cms_read_newest', args: { p_item_id: id(1), p_language: 'de' } },
      { fn: 'cms_list_versions', args: { p_item_id: id(1), p_language: 'all' } },
    ]);
  });

  it('gives null and an empty list when the function returns no rows (a visitor asking for drafts)', async () => {
    const { store } = fakeClient({ cms_read_published: { data: [] }, cms_read_newest: { data: [] }, cms_list_versions: { data: [] }, cms_list_items: { data: [] }, cms_list_usages: { data: [] } });
    expect(await store.items.readPublished(id(1), 'en')).toBeNull();
    expect(await store.items.readNewest(id(1), 'en')).toBeNull();
    expect(await store.items.listVersions(id(1), 'en')).toEqual([]);
    expect(await store.items.listItems()).toEqual([]);
    expect(await store.items.listUsages(id(1))).toEqual([]);
  });

  it('resolveItems passes the ids, the language and the preview flag, and maps the rows', async () => {
    const { store, calls } = fakeClient({
      cms_resolve_items: { data: [{ item_id: id(1), type_key: 'card', reusable: true, translatable: true, language: 'en', version: 2, status: 'draft', is_draft: true, content: { a: 1 } }] },
    });
    expect(await store.items.resolveItems([id(1), id(2)], 'de', true)).toEqual([
      { itemId: id(1), typeKey: 'card', reusable: true, translatable: true, language: 'en', version: 2, status: 'draft', isDraft: true, content: { a: 1 } },
    ]);
    await store.items.resolveItems([id(1)], 'sl', false);
    expect(calls.map((c) => c.args)).toEqual([
      { p_item_ids: [id(1), id(2)], p_language: 'de', p_preview: true },
      { p_item_ids: [id(1)], p_language: 'sl', p_preview: false },
    ]);
  });

  it('saveDraft, publish, restore pass their arguments, including the references', async () => {
    const { store, calls } = fakeClient({ cms_save_item_draft: { data: 4 }, cms_restore_item: { data: 5 } });
    expect(await store.items.saveDraft(id(1), 'en', { a: 1 }, [id(2)], 3)).toBe(4);
    expect(await store.items.saveDraft(id(1), 'en', { a: 1 }, [], null)).toBe(4);
    await store.items.publish(id(1), 'en', 4);
    expect(await store.items.restore(id(1), 'en', 1, 4)).toBe(5);
    expect(calls).toEqual([
      { fn: 'cms_save_item_draft', args: { p_item_id: id(1), p_language: 'en', p_base_version: 3, p_content: { a: 1 }, p_refs: [id(2)] } },
      { fn: 'cms_save_item_draft', args: { p_item_id: id(1), p_language: 'en', p_base_version: null, p_content: { a: 1 }, p_refs: [] } },
      { fn: 'cms_publish_item', args: { p_item_id: id(1), p_language: 'en', p_version: 4 } },
      { fn: 'cms_restore_item', args: { p_item_id: id(1), p_language: 'en', p_version: 1, p_base_version: 4 } },
    ]);
  });

  it('usages and delete', async () => {
    const { store, calls } = fakeClient({
      cms_list_usages: { data: [{ source_kind: 'layout', source_id: id(7), source_label: 'home', source_language: null, in_published: true, in_newest: false }] },
    });
    expect(await store.items.listUsages(id(1))).toEqual([{ sourceKind: 'layout', sourceId: id(7), sourceLabel: 'home', sourceLanguage: null, inPublished: true, inNewest: false }]);
    await store.items.deleteItem(id(1));
    expect(calls).toEqual([
      { fn: 'cms_list_usages', args: { p_item_id: id(1) } },
      { fn: 'cms_delete_item', args: { p_item_id: id(1) } },
    ]);
  });
});

describe('layouts, templates, assets: functions and columns', () => {
  it('maps layout reads and calls the layout functions with their exact arguments', async () => {
    const { store, calls } = fakeClient({
      cms_read_layout: { data: [{ version: 2, status: 'published', content: { sections: [] }, changed_at: at, is_draft: false }] },
      cms_read_layout_newest: { data: [{ version: 3, status: 'draft', content: { sections: [] }, changed_by: null, changed_by_email: null, changed_at: at, restored_from: 2 }] },
      cms_list_layout_versions: { data: [{ version: 3, status: 'draft', changed_by: null, changed_by_email: null, changed_at: at, restored_from: 2 }] },
      cms_list_layouts: { data: [{ id: id(5), page_key: 'home', published_version: 2, created_at: at }] },
      cms_save_layout_draft: { data: 4 },
      cms_restore_layout: { data: 5 },
      cms_reorder_slot: { data: 6 },
    });
    expect(await store.layouts.readPublished('home')).toEqual({ pageKey: 'home', version: 2, status: 'published', content: { sections: [] }, changedBy: null, changedByEmail: null, changedAt: at, restoredFrom: null });
    expect(await store.layouts.readNewest('home')).toMatchObject({ pageKey: 'home', version: 3, restoredFrom: 2 });
    expect((await store.layouts.listVersions('home'))[0]).not.toHaveProperty('content');
    expect(await store.layouts.listLayouts()).toEqual([{ id: id(5), pageKey: 'home', publishedVersion: 2, createdAt: at }]);
    expect(await store.layouts.saveDraft('home', { sections: [] }, [id(1)], 3)).toBe(4);
    await store.layouts.publish('home', 4);
    expect(await store.layouts.restore('home', 1, 4)).toBe(5);
    expect(await store.layouts.reorderSlot('home', 'hero', 'cards', [id(2), id(1)], 5)).toBe(6);
    expect(calls).toEqual([
      { fn: 'cms_read_layout', args: { p_page_key: 'home', p_preview: false } },
      { fn: 'cms_read_layout_newest', args: { p_page_key: 'home' } },
      { fn: 'cms_list_layout_versions', args: { p_page_key: 'home' } },
      { fn: 'cms_list_layouts', args: {} },
      { fn: 'cms_save_layout_draft', args: { p_page_key: 'home', p_base_version: 3, p_content: { sections: [] }, p_refs: [id(1)] } },
      { fn: 'cms_publish_layout', args: { p_page_key: 'home', p_version: 4 } },
      { fn: 'cms_restore_layout', args: { p_page_key: 'home', p_version: 1, p_base_version: 4 } },
      { fn: 'cms_reorder_slot', args: { p_page_key: 'home', p_base_version: 5, p_section_key: 'hero', p_slot_key: 'cards', p_item_ids: [id(2), id(1)] } },
    ]);
  });

  it('reads a layout for a page through cms_read_layout with the preview flag, for every caller', async () => {
    const { store, calls } = fakeClient({ cms_read_layout: { data: [{ version: 3, status: 'draft', content: { sections: [] }, changed_at: at, is_draft: true }] } });
    expect(await store.layouts.read('home', true)).toEqual({ pageKey: 'home', version: 3, status: 'draft', isDraft: true, content: { sections: [] }, changedAt: at });
    await store.layouts.read('home', false);
    expect(calls).toEqual([
      { fn: 'cms_read_layout', args: { p_page_key: 'home', p_preview: true } },
      { fn: 'cms_read_layout', args: { p_page_key: 'home', p_preview: false } },
    ]);
    expect(await fakeClient({ cms_read_layout: { data: [] } }).store.layouts.read('home', true)).toBeNull();
  });

  it('returns null for a layout with no published version', async () => {
    const { store } = fakeClient({ cms_read_layout: { data: [] } });
    expect(await store.layouts.readPublished('home')).toBeNull();
  });

  it('lists templates through cms_list_templates, reads one from the table with every column, and saves through cms_save_template', async () => {
    const row = { key: 'banner-section', name: 'Banner', container_type_key: 'section', slots: [{ key: 'banner', label: 'B', allowedTypeKeys: ['banner'], min: 1, max: 1 }], built_in: true, created_at: at, updated_at: at };
    const { store, calls, reads } = fakeClient({ cms_list_templates: { data: [row] }, cms_save_template: { data: row }, 'table:cms_templates': { data: [row] } });
    const expected = { key: 'banner-section', name: 'Banner', containerTypeKey: 'section', slots: row.slots, builtIn: true, createdAt: at, updatedAt: at };
    expect(await store.templates.list()).toEqual([expected]);
    expect(await store.templates.get('banner-section')).toEqual(expected);
    expect(await store.templates.save({ key: 'banner-section', name: 'Banner', containerTypeKey: 'section', slots: row.slots, builtIn: false })).toEqual(expected);
    expect(reads).toEqual([{ table: 'cms_templates', columns: 'key, name, container_type_key, slots, built_in, created_at, updated_at', filters: [['key', 'banner-section']] }]);
    expect(calls[1]).toEqual({ fn: 'cms_save_template', args: { p_key: 'banner-section', p_name: 'Banner', p_container_type_key: 'section', p_slots: row.slots } });
  });

  it('reads assets from the table with exactly the columns visitors may select, and registers through cms_register_asset', async () => {
    const row = { id: id(3), bucket: 'site-images', path: 'a.png', mime: 'image/png', bytes: 1234, width: 10, height: 20, label: 'A', created_at: at };
    const { store, calls, reads } = fakeClient({ 'table:cms_assets': { data: [row] }, cms_register_asset: { data: { ...row, bytes: 1234 } } });
    const columns = 'id, bucket, path, mime, bytes, width, height, label, created_at';
    const listed = await store.assets.list();
    expect(listed).toEqual([{ id: id(3), bucket: 'site-images', path: 'a.png', mime: 'image/png', bytes: 1234, width: 10, height: 20, label: 'A', createdAt: at }]);
    expect(await store.assets.get(id(3))).toMatchObject({ id: id(3) });
    expect(reads).toEqual([
      { table: 'cms_assets', columns, filters: [] },
      { table: 'cms_assets', columns, filters: [['id', id(3)]] },
    ]);
    const registered = await store.assets.register({ path: 'a.png', mime: 'image/png', bytes: 1234, width: 10, height: 20, label: 'A' });
    expect(registered.bytes).toBe(1234);
    expect(calls).toEqual([{ fn: 'cms_register_asset', args: { p_path: 'a.png', p_mime: 'image/png', p_bytes: 1234, p_width: 10, p_height: 20, p_label: 'A' } }]);
  });

  it('turns a failed table read into an error and an absent asset into null', async () => {
    const { store } = fakeClient({ 'table:cms_assets': { error: { code: '42501', message: 'permission denied for table cms_assets' } } });
    expect(await rejects(store.assets.list())).toBeInstanceOf(ContentPermissionError);
    const empty = fakeClient({ 'table:cms_assets': { data: [] } });
    expect(await empty.store.assets.get(id(1))).toBeNull();
  });
});

describe('error codes map to the error classes', () => {
  const failing = (code: string, details: unknown, message = 'db message') =>
    fakeClient({ cms_save_item_draft: { error: { code, message, details: details === undefined ? null : typeof details === 'string' ? details : JSON.stringify(details) } } }).store.items.saveDraft(id(1), 'en', {}, [], null);

  it('exposes the codes the contract names', () => {
    expect(CMS_ERROR_CODES).toMatchObject({ stale: 'CE001', permission: '42501', invalid: '22023', notFound: 'CM001', referenced: 'CM002', danglingReference: 'CM003', slotRule: 'CM004', notReusable: 'CM005', assetInvalid: 'CM006', layoutIncomplete: 'CM007', cycle: 'CM008' });
  });

  it('CE001: a conflict carrying the newest version, from the camelCase detail (snake_case is read too)', async () => {
    const error = (await rejects(failing('CE001', { version: 7, status: 'draft', content: { a: 1 }, changedBy: null, changedByEmail: 'x@example.test', changedAt: at, restoredFrom: 2 }))) as ContentConflictError;
    expect(error).toBeInstanceOf(ContentConflictError);
    expect(error.current).toEqual({ version: 7, status: 'draft', content: { a: 1 }, changedBy: null, changedByEmail: 'x@example.test', changedAt: at, restoredFrom: 2 });
  });

  it('CE001 also reads snake_case keys', async () => {
    const error = (await rejects(failing('CE001', { version: 2, status: 'draft', content: {}, changed_by_email: 'y@example.test', changed_at: at, restored_from: 1 }))) as ContentConflictError;
    expect(error.current).toMatchObject({ version: 2, changedByEmail: 'y@example.test', changedAt: at, restoredFrom: 1 });
  });

  it('CE001 with no readable detail still conflicts', async () => {
    const error = (await rejects(failing('CE001', 'not json'))) as ContentConflictError;
    expect(error).toBeInstanceOf(ContentConflictError);
    expect(error.current.version).toBe(0);
  });

  it('42501 -> permission, with the database message', async () => {
    const error = await rejects(failing('42501', undefined, 'Only editors and owners can change content'));
    expect(error).toBeInstanceOf(ContentPermissionError);
    expect((error as Error).message).toBe('Only editors and owners can change content');
  });

  it('22023 and CM006 -> validation', async () => {
    for (const code of ['22023', 'CM006']) {
      const error = await rejects(failing(code, undefined, 'bad argument'));
      expect(error).toBeInstanceOf(ContentValidationError);
      expect((error as ContentValidationError).issues).toEqual(['bad argument']);
    }
  });

  it('CM001 -> not found, naming what the call was about', async () => {
    const item = (await rejects(failing('CM001', undefined))) as ContentNotFoundError;
    expect(item).toBeInstanceOf(ContentNotFoundError);
    expect(item).toMatchObject({ kind: 'item', id: id(1) });
    const layout = fakeClient({ cms_publish_layout: { error: { code: 'CM001', message: 'm' } } });
    expect(await rejects(layout.store.layouts.publish('home', 1))).toMatchObject({ kind: 'layout', id: 'home' });
    const detailed = fakeClient({ cms_publish_item: { error: { code: 'CM001', message: 'm', details: JSON.stringify({ kind: 'item', id: id(8) }) } } });
    expect(await rejects(detailed.store.items.publish(id(1), 'en', 1))).toMatchObject({ kind: 'item', id: id(8) });
  });

  it('CM002 -> referenced, with the usages parsed', async () => {
    const usage = { sourceKind: 'item', sourceId: id(2), sourceLabel: 'Parent', sourceLanguage: 'en', inPublished: true, inNewest: true };
    const fake = fakeClient({ cms_delete_item: { error: { code: 'CM002', message: 'm', details: JSON.stringify([usage]) } } });
    const error = (await rejects(fake.store.items.deleteItem(id(1)))) as ContentReferencedError;
    expect(error).toBeInstanceOf(ContentReferencedError);
    expect(error.itemId).toBe(id(1));
    expect(error.usages).toEqual([{ sourceKind: 'item', sourceId: id(2), sourceLabel: 'Parent', sourceLanguage: 'en', inPublished: true, inNewest: true }]);
  });

  it.each([
    ['CM003', 'missing'],
    ['CM005', 'not-reusable'],
    ['CM008', 'cycle'],
  ])('%s -> a reference error (%s) with the ids from the detail', async (code, reason) => {
    const error = (await rejects(failing(code, [id(4), id(5)]))) as ContentReferenceError;
    expect(error).toBeInstanceOf(ContentReferenceError);
    expect(error).toMatchObject({ reason, itemIds: [id(4), id(5)] });
  });

  it.each(['CM004', 'CM007'])('%s -> a layout rule error with one issue per problem, from a JSON array or JSON lines', async (code) => {
    const problems = [{ section: 'hero', slot: 'banner', message: 'at most 1' }, { section: 'x', slot: null, message: 'no template' }];
    for (const details of [problems, problems.map((p) => JSON.stringify(p)).join('\n')]) {
      const error = (await rejects(failing(code, details))) as LayoutRuleError;
      expect(error).toBeInstanceOf(LayoutRuleError);
      expect(error.issues).toEqual(['hero.banner: at most 1', 'x: no template']);
    }
  });

  it('an unknown code is rethrown as a plain error with the message', async () => {
    const error = await rejects(failing('XX999', undefined, 'boom'));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('boom');
    expect(error).not.toBeInstanceOf(ContentValidationError);
  });

  it('maps errors from every call, not only saves', async () => {
    const fake = fakeClient({ cms_resolve_items: { error: { code: '42501', message: 'm' } }, cms_save_template: { error: { code: '42501', message: 'owners only' } } });
    expect(await rejects(fake.store.items.resolveItems([], 'en', false))).toBeInstanceOf(ContentPermissionError);
    expect(await rejects(fake.store.templates.save({ key: 'a', name: 'A', containerTypeKey: 'section', slots: [{ key: 'b', label: 'B', allowedTypeKeys: ['x'], min: 0, max: null }], builtIn: false }))).toBeInstanceOf(ContentPermissionError);
  });
});

describe('the legacy section entries keep calling the existing content_* functions', () => {
  it('maps their rows and arguments', async () => {
    const version = { version: 2, status: 'published', content: { a: 1 }, changed_by: null, changed_by_email: null, changed_at: at, restored_from: null };
    const { store, calls } = fakeClient({
      content_read_published: { data: [version] },
      content_read_newest: { data: [version] },
      content_list_versions: { data: [{ ...version, content: undefined }] },
      content_save_draft: { data: 3 },
      content_restore: { data: 4 },
    });
    expect(await store.readPublished('hero', 'sl')).toEqual({ version: 2, status: 'published', content: { a: 1 }, changedBy: null, changedByEmail: null, changedAt: at, restoredFrom: null });
    expect((await store.readNewest('hero', 'sl'))?.version).toBe(2);
    expect((await store.listVersions('hero', 'sl'))[0]).not.toHaveProperty('content');
    expect(await store.saveDraft('hero', 'sl', { a: 1 }, 2)).toBe(3);
    await store.publish('hero', 'sl', 3);
    expect(await store.restore('hero', 'sl', 1, 3)).toBe(4);
    expect(calls.map((c) => c.fn)).toEqual(['content_read_published', 'content_read_newest', 'content_list_versions', 'content_save_draft', 'content_publish', 'content_restore']);
  });

  it('maps a stale save to the conflict error', async () => {
    const { store } = fakeClient({ content_save_draft: { error: { code: 'CE001', message: 'stale', details: JSON.stringify({ version: 5, status: 'draft', content: {}, changed_at: at }) } } });
    const error = (await rejects(store.saveDraft('hero', 'sl', {}, 1))) as ContentConflictError;
    expect(error).toBeInstanceOf(ContentConflictError);
    expect(error.current.version).toBe(5);
  });
});
