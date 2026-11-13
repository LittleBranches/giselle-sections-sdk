import { z } from 'zod';

/** A key that names a type, a template, a slot, a page or a section of a page: lowercase letters, digits and hyphens. */
export const keySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/, 'Use lowercase letters, digits and hyphens, starting with a letter.');

/** The id of an item, a layout or an asset: a UUID, made by the database. */
export const idSchema = z.uuid();

/** An ISO 8601 timestamp, as the database returns it. */
export const timestampSchema = z.string().min(1);
