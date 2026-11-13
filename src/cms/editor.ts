import type { EditorWidget } from './content-type';

/**
 * What the generated editor builds one field from: the output of `describeFields(type)` (WP1), the input of the form
 * (the next slice, and the dynamic form the portfolio's blog post already uses). Derived from the type's zod schema, then
 * refined by the type's `editor.overrides`; a value in an override always wins over what the schema implies.
 *
 * `path` is the field's dotted path (`title`, `address.city`); inside a list, the element is `cards.*` and its fields
 * are `cards.*.title`. Overrides are keyed by the same paths.
 */
export type FieldConfigBase = {
  path: string;
  label: string;
  help?: string;
  placeholder?: string;
  /** `false` when the schema marks the field optional, nullable or with a default. */
  required: boolean;
  /** The accordion the field is shown in. */
  group: string;
  /** From the override; `null` keeps the schema's order. */
  order: number | null;
  hidden: boolean;
  readOnly: boolean;
  /** The schema's default, when it has one. */
  defaultValue?: unknown;
};

export type FieldConfig = FieldConfigBase &
  (
    | { widget: Extract<EditorWidget, 'text' | 'textarea' | 'richtext' | 'url' | 'date'>; minLength?: number; maxLength?: number; rows?: number }
    | { widget: 'number'; min?: number; max?: number; integer: boolean }
    | { widget: 'switch' }
    | { widget: 'select'; options: { value: string; label: string }[] }
    | { widget: 'image' }
    | { widget: 'item-ref'; allowedTypeKeys: string[] }
    | { widget: 'item-ref-list'; allowedTypeKeys: string[]; min?: number; max?: number }
    | { widget: 'list'; item: FieldConfig; min?: number; max?: number }
    | { widget: 'group'; fields: FieldConfig[] }
  );
