import { z } from 'zod';

import { idSchema, timestampSchema } from './keys';

/** What the images bucket accepts; the bucket enforces the same list and the size limit. */
export const ASSET_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const ASSET_MAX_BYTES = 5 * 1024 * 1024;

/** A file in the bucket, registered so items can point at it by id. Assets are never changed or deleted through the app. */
export const assetSchema = z
  .object({
    id: idSchema,
    bucket: z.string().min(1),
    /** The object's path in the bucket: no leading slash, no `..`. Unique per bucket: a file is never replaced, each upload has a new name. */
    path: z
      .string()
      .min(1)
      .max(500)
      .refine((path) => !path.startsWith('/') && !path.split('/').includes('..'), { message: 'The path must be inside the bucket' }),
    mime: z.enum(ASSET_MIME_TYPES),
    bytes: z.number().int().min(1).max(ASSET_MAX_BYTES),
    width: z.number().int().min(1).nullable(),
    height: z.number().int().min(1).nullable(),
    /** A name for people to find the file by. Alternative text is content: it belongs to the item, per language. */
    label: z.string().max(200).nullable(),
    createdAt: timestampSchema,
  })
  .strict();
export type Asset = z.infer<typeof assetSchema>;

export const newAssetSchema = assetSchema.pick({ path: true, mime: true, bytes: true, width: true, height: true, label: true });
export type NewAsset = z.input<typeof newAssetSchema>;

/**
 * How content points at an image: an asset id (a UUID) or, for content written before assets existed, the path string
 * it already holds. A value in UUID form is an id; anything else is a path.
 */
export const assetRefSchema = z.string().min(1).max(500).meta({ widget: 'image' });
export type AssetRef = z.infer<typeof assetRefSchema>;
