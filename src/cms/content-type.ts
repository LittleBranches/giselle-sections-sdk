import { z, type ZodType } from 'zod';

import { keySchema } from './keys';

/** A block is a data-driven component with a schema; a container holds items in its slots. */
export const contentKindSchema = z.enum(['block', 'container']);
export type ContentKind = z.infer<typeof contentKindSchema>;

/**
 * Where a type's instances live. `document`: versioned JSON entries in the shared tables. `collection`: rows in a table
 * a site already has, reached through an adapter (see `CollectionAdapter`), with the same generated form.
 */
export const storageKindSchema = z.enum(['document', 'collection']);
export type StorageKind = z.infer<typeof storageKindSchema>;

/** The form widgets the generated editor knows. A field with no override gets the widget its schema type implies. */
export const EDITOR_WIDGETS = [
  'text',
  'textarea',
  'richtext',
  'number',
  'select',
  'switch',
  'date',
  'url',
  'image',
  'item-ref',
  'item-ref-list',
  'list',
  'group',
] as const;
export type EditorWidget = (typeof EDITOR_WIDGETS)[number];

/** What a type can say about one field of its form. Everything is optional: the schema alone gives a working form. */
export const editorFieldOverrideSchema = z
  .object({
    label: z.string().min(1).max(120).optional(),
    help: z.string().max(500).optional(),
    placeholder: z.string().max(200).optional(),
    widget: z.enum(EDITOR_WIDGETS).optional(),
    /** The accordion the field is shown in. Fields with no group go into the first accordion, named "Details". */
    group: z.string().min(1).max(60).optional(),
    /** Lower comes first within a group. Fields with no order keep the schema's order, after the ordered ones. */
    order: z.number().int().optional(),
    hidden: z.boolean().optional(),
    readOnly: z.boolean().optional(),
    /** Rows of a `textarea` or `richtext`. */
    rows: z.number().int().min(1).max(40).optional(),
    /** The choices of a `select` that the schema does not already list as an enum. */
    options: z.array(z.object({ value: z.string(), label: z.string() })).min(1).optional(),
    /** For an `item-ref` or `item-ref-list`: the type keys the picker offers. Defaults to every block type. */
    allowedTypeKeys: z.array(keySchema).min(1).optional(),
  })
  .strict();
export type EditorFieldOverride = z.infer<typeof editorFieldOverrideSchema>;

/**
 * Overrides by field path: `title`, `address.city`, and `cards.*.title` for a field inside every element of a list. A
 * path that names no field of the schema is a mistake the registry refuses at registration.
 */
export const editorOverridesSchema = z.record(z.string().min(1), editorFieldOverrideSchema);
export type EditorOverrides = z.infer<typeof editorOverridesSchema>;

/** How a type's form is laid out beyond its fields. */
export const editorConfigSchema = z
  .object({
    overrides: editorOverridesSchema.default({}),
    /** Accordion titles in the order shown. A group named in an override but missing here is appended. */
    groups: z.array(z.string().min(1).max(60)).default([]),
    /** `true` where a type truly needs a hand-built form: the generated editor shows the site's own form (see the contracts). */
    custom: z.boolean().default(false),
  })
  .strict();
export type EditorConfig = z.infer<typeof editorConfigSchema>;

/** A place in a container where items go. A template narrows it; it cannot widen it. */
export const slotDefinitionSchema = z
  .object({
    key: keySchema,
    label: z.string().min(1).max(80),
    /** Block type keys that may go in the slot. */
    allowedTypeKeys: z.array(keySchema).min(1),
    /** Fewest items. Checked on publish, not on a draft save. Default 0. */
    min: z.number().int().min(0).default(0),
    /** Most items. `null` for no limit (the database still caps a slot at 100). */
    max: z.number().int().min(1).nullable().default(null),
  })
  .strict()
  .refine((slot) => slot.max === null || slot.min <= slot.max, { message: 'min cannot be greater than max', path: ['min'] });
export type SlotDefinition = z.infer<typeof slotDefinitionSchema>;

const componentKeySchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z][A-Za-z0-9._-]*$/, 'A component key is letters, digits, dots, hyphens and underscores.');

const isZodType = (value: unknown): value is ZodType => typeof value === 'object' && value !== null && 'safeParse' in value;

/**
 * What a site registers for a content type. Plain data, no component code: the SDK has no React, so the library
 * component is named by a string key, and the site resolves the key to the component (see `ComponentResolver`).
 */
export const contentTypeDefinitionSchema = z
  .object({
    key: keySchema,
    label: z.string().min(1).max(80),
    description: z.string().max(300).optional(),
    kind: contentKindSchema,
    storage: storageKindSchema,
    /** `true`: one entry per language. `false`: one entry in all languages. A collection type is never translatable here: its table owns its languages. */
    translatable: z.boolean(),
    /** The one schema: the TypeScript type, the check on save and on read, and the editor's fields. */
    schema: z.custom<ZodType>(isZodType, { message: 'schema must be a zod schema' }),
    /** The library component that renders the type, by a key the site's resolver knows. */
    component: componentKeySchema,
    /** For a collection type: the key of the adapter the site supplies. Forbidden for a document type. */
    adapter: keySchema.optional(),
    editor: editorConfigSchema.default({ overrides: {}, groups: [], custom: false }),
    /** For a container: its slots. Forbidden for a block. */
    slots: z.array(slotDefinitionSchema).default([]),
  })
  .strict()
  .superRefine((type, ctx) => {
    const add = (message: string, path: (string | number)[]) => ctx.addIssue({ code: 'custom', message, path });
    if (type.kind === 'block' && type.slots.length > 0) add('A block has no slots', ['slots']);
    if (type.kind === 'container' && type.slots.length === 0) add('A container needs at least one slot', ['slots']);
    if (type.kind === 'container' && type.storage !== 'document') add('A container is a document type', ['storage']);
    if (type.storage === 'collection' && !type.adapter) add('A collection type needs an adapter key', ['adapter']);
    if (type.storage === 'document' && type.adapter) add('A document type has no adapter', ['adapter']);
    if (type.storage === 'collection' && type.translatable) add('A collection type is not translatable here', ['translatable']);
    const seen = new Set<string>();
    type.slots.forEach((slot, index) => {
      if (seen.has(slot.key)) add(`Duplicate slot key "${slot.key}"`, ['slots', index, 'key']);
      seen.add(slot.key);
    });
  });

/** A content type as registered, before defaults are filled in (what a site writes). */
export type ContentTypeInput<T = unknown> = Omit<z.input<typeof contentTypeDefinitionSchema>, 'schema'> & { schema: ZodType<T> };

/** A content type as the registry returns it: defaults filled in, validated. */
export type ContentType<T = unknown> = Omit<z.output<typeof contentTypeDefinitionSchema>, 'schema'> & { schema: ZodType<T> };
