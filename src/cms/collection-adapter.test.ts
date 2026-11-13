import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ContentValidationError } from '../content/errors';
import { CollectionConflictError, ContentNotFoundError, createCollectionAdapter, type CollectionRowStore } from './index';

type Post = { title: string; body: string };
type Row = { id: number; title: string; body: string; published: boolean; updated: string };
const schema = z.object({ title: z.string().min(1), body: z.string() });

/** A table the way a site has it: rows with their own column names. */
function table(initial: Row[] = []) {
  const rows = [...initial];
  let clock = 0;
  let nextId = 100;
  const tick = () => `2026-11-14T10:00:${String(++clock).padStart(2, '0')}Z`;
  const rowStore: CollectionRowStore<Row, { title: string; body: string }> = {
    async list({ status, limit, cursor }) {
      const filtered = rows.filter((r) => !status || r.published === (status === 'published')).sort((a, b) => b.id - a.id);
      const start = cursor ? filtered.findIndex((r) => String(r.id) === cursor) + 1 : 0;
      const page = filtered.slice(start, limit ? start + limit : undefined);
      const more = limit !== undefined && start + limit < filtered.length;
      return { rows: page, nextCursor: more ? String(page[page.length - 1]!.id) : null };
    },
    async get(id) {
      return rows.find((r) => String(r.id) === id) ?? null;
    },
    async insert(input) {
      const row = { id: nextId++, ...input, published: false, updated: tick() };
      rows.push(row);
      return row;
    },
    async update(id, input, expectedUpdated) {
      if (expectedUpdated === null) throw new Error('an unknown base must not reach the row store');
      const row = rows.find((r) => String(r.id) === id);
      if (!row || row.updated !== expectedUpdated) return null;
      Object.assign(row, input, { updated: tick() });
      return row;
    },
    async setStatus(id, status) {
      const row = rows.find((r) => String(r.id) === id);
      if (!row) return null;
      row.published = status === 'published';
      row.updated = tick();
      return row;
    },
    async remove(id) {
      const index = rows.findIndex((r) => String(r.id) === id);
      if (index >= 0) rows.splice(index, 1);
    },
  };
  return { rows, rowStore, touch: (id: string) => { rows.find((r) => String(r.id) === id)!.updated = tick(); } };
}

const adapterOf = (t: ReturnType<typeof table>) =>
  createCollectionAdapter<Post, Row, { title: string; body: string }>({
    key: 'posts',
    schema,
    rows: t.rowStore,
    toRecord: (row) => ({ id: String(row.id), status: row.published ? 'published' : 'draft', value: { title: row.title, body: row.body }, updatedAt: row.updated }),
    fromValue: (value) => ({ title: value.title, body: value.body }),
  });

const rejects = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
};

describe('createCollectionAdapter', () => {
  it('has the key it was given', () => {
    expect(adapterOf(table()).key).toBe('posts');
  });

  it('creates a draft record from a checked value and reads it back', async () => {
    const adapter = adapterOf(table());
    const created = await adapter.create({ title: 'Hello', body: 'World' });
    expect(created).toMatchObject({ status: 'draft', value: { title: 'Hello', body: 'World' } });
    expect(await adapter.get(created.id)).toEqual(created);
    expect(await adapter.get('999')).toBeNull();
  });

  it('refuses a value that does not match the schema, on create and update, writing nothing', async () => {
    const t = table();
    const adapter = adapterOf(t);
    expect(await rejects(adapter.create({ title: '', body: 'x' }))).toBeInstanceOf(ContentValidationError);
    expect(t.rows).toHaveLength(0);
    const record = await adapter.create({ title: 'ok', body: 'x' });
    expect(await rejects(adapter.update(record.id, { title: '', body: 'x' }, record.updatedAt))).toBeInstanceOf(ContentValidationError);
    expect((await adapter.get(record.id))?.value.title).toBe('ok');
  });

  it('refuses a stored row that does not match the schema when it is read', async () => {
    const t = table([{ id: 1, title: '', body: 'x', published: true, updated: 'u1' }]);
    expect(await rejects(adapterOf(t).get('1'))).toBeInstanceOf(ContentValidationError);
    expect(await rejects(adapterOf(t).list())).toBeInstanceOf(ContentValidationError);
  });

  it('updates when the base is the stored updatedAt, and refuses a stale base with the stored record', async () => {
    const t = table();
    const adapter = adapterOf(t);
    const record = await adapter.create({ title: 'a', body: 'x' });
    const updated = await adapter.update(record.id, { title: 'b', body: 'x' }, record.updatedAt);
    expect(updated.value.title).toBe('b');
    expect(updated.updatedAt).not.toBe(record.updatedAt);
    const error = (await rejects(adapter.update(record.id, { title: 'mine', body: 'x' }, record.updatedAt))) as CollectionConflictError<Post>;
    expect(error).toBeInstanceOf(CollectionConflictError);
    expect(error.current).toEqual(updated);
    expect((await adapter.get(record.id))?.value.title).toBe('b');
  });

  it('treats an unknown base (null) as stale, and refuses a record that does not exist', async () => {
    const adapter = adapterOf(table());
    const record = await adapter.create({ title: 'a', body: 'x' });
    expect(await rejects(adapter.update(record.id, { title: 'b', body: 'x' }, null))).toBeInstanceOf(CollectionConflictError);
    expect(await rejects(adapter.update('999', { title: 'b', body: 'x' }, 'u'))).toBeInstanceOf(ContentNotFoundError);
  });

  it('moves a record between draft and published, and removes it', async () => {
    const t = table();
    const adapter = adapterOf(t);
    const record = await adapter.create({ title: 'a', body: 'x' });
    expect((await adapter.setStatus(record.id, 'published')).status).toBe('published');
    expect((await adapter.setStatus(record.id, 'draft')).status).toBe('draft');
    expect(await rejects(adapter.setStatus('999', 'published'))).toBeInstanceOf(ContentNotFoundError);
    await adapter.remove(record.id);
    expect(await adapter.get(record.id)).toBeNull();
  });

  it('lists records, narrowed by status, with a cursor', async () => {
    const t = table([
      { id: 1, title: 'a', body: '', published: true, updated: 'u1' },
      { id: 2, title: 'b', body: '', published: false, updated: 'u2' },
      { id: 3, title: 'c', body: '', published: true, updated: 'u3' },
    ]);
    const adapter = adapterOf(t);
    expect((await adapter.list()).records.map((r) => r.id)).toEqual(['3', '2', '1']);
    expect((await adapter.list({ status: 'published' })).records.map((r) => r.id)).toEqual(['3', '1']);
    const first = await adapter.list({ limit: 2 });
    expect(first.records.map((r) => r.id)).toEqual(['3', '2']);
    expect(first.nextCursor).toBe('2');
    const second = await adapter.list({ limit: 2, cursor: first.nextCursor! });
    expect(second.records.map((r) => r.id)).toEqual(['1']);
    expect(second.nextCursor).toBeNull();
  });
});
