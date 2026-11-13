import type { ZodType } from 'zod';

import { ContentValidationError } from '../content/errors';
import { CollectionConflictError, ContentNotFoundError } from './errors';
import type { CollectionAdapter, CollectionRecord } from './item';

/**
 * What a site writes to reach a table it already has (blog posts, say): row operations in its own column names. The
 * helper below turns them into a `CollectionAdapter`; the SDK never learns a column name.
 */
export interface CollectionRowStore<Row, Input> {
  /** Newest first. `cursor` is whatever `nextCursor` returned before. */
  list(options: { status?: 'draft' | 'published'; limit?: number; cursor?: string }): Promise<{ rows: Row[]; nextCursor: string | null }>;
  get(id: string): Promise<Row | null>;
  insert(input: Input): Promise<Row>;
  /** Must update only when the stored `updatedAt` still equals `expectedUpdatedAt`, in one statement; `null` when no row matched. */
  update(id: string, input: Input, expectedUpdatedAt: string): Promise<Row | null>;
  /** `null` when there is no such row. */
  setStatus(id: string, status: 'draft' | 'published'): Promise<Row | null>;
  remove(id: string): Promise<void>;
}

export type CollectionAdapterOptions<T, Row, Input> = {
  /** Matches `ContentType.adapter`. */
  key: string;
  /** The type's schema: values are checked on the way in and rows on the way out. */
  schema: ZodType<T>;
  rows: CollectionRowStore<Row, Input>;
  toRecord(row: Row): CollectionRecord<unknown>;
  fromValue(value: T): Input;
};

function issuesOf(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string[] {
  return error.issues.map((issue) => `${issue.path.map(String).join('.') || '(value)'}: ${issue.message}`);
}

/**
 * A `CollectionAdapter` over a site's own table. It checks values against the type's schema (`ContentValidationError`,
 * nothing written), checks rows against it when they are read, and detects a stale save by `updatedAt` with a
 * compare-and-set in the row store (`CollectionConflictError` carrying the stored record). An unknown base
 * (`baseUpdatedAt` null) cannot be shown to be current, so an update with it is refused as stale.
 */
export function createCollectionAdapter<T, Row, Input>(options: CollectionAdapterOptions<T, Row, Input>): CollectionAdapter<T> {
  const { key, schema, rows, toRecord, fromValue } = options;

  function check(value: unknown, when: 'save' | 'read'): T {
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    const issues = issuesOf(result.error);
    throw new ContentValidationError(`${when === 'save' ? 'That record is not valid' : `A stored "${key}" record is not valid`}: ${issues.join('; ')}`, issues);
  }
  const record = (row: Row): CollectionRecord<T> => {
    const raw = toRecord(row);
    return { ...raw, value: check(raw.value, 'read') };
  };
  const notFound = (id: string) => new ContentNotFoundError('item', id);

  return {
    key,
    async list(listOptions) {
      const page = await rows.list(listOptions ?? {});
      return { records: page.rows.map(record), nextCursor: page.nextCursor };
    },
    async get(id) {
      const row = await rows.get(id);
      return row ? record(row) : null;
    },
    async create(value) {
      return record(await rows.insert(fromValue(check(value, 'save'))));
    },
    async update(id, value, baseUpdatedAt) {
      const input = fromValue(check(value, 'save'));
      if (baseUpdatedAt !== null) {
        const updated = await rows.update(id, input, baseUpdatedAt);
        if (updated) return record(updated);
      }
      const current = await rows.get(id);
      if (!current) throw notFound(id);
      throw new CollectionConflictError(record(current));
    },
    async setStatus(id, status) {
      const row = await rows.setStatus(id, status);
      if (!row) throw notFound(id);
      return record(row);
    },
    async remove(id) {
      await rows.remove(id);
    },
  };
}
