import type { ContentType, EditorFieldOverride, EditorWidget } from './content-type';
import type { FieldConfig } from './editor';
import { analyzeSchema, type FieldNode } from './introspect';

export const DEFAULT_FIELD_GROUP = 'Details';
/** A string longer than this is edited in a textarea. */
const TEXTAREA_THRESHOLD = 200;

export type DescribeFieldsOptions = {
  /**
   * The keys of the registered block types. An `item-ref` field with no `allowedTypeKeys` override offers these; without
   * them the list is empty, which the editor reads as "every block type".
   */
  blockTypeKeys?: readonly string[];
};

/** `ctaLabel`, `cta_label` and `cta-label` all become `Cta label`. */
export function humanise(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const COMPATIBLE: Record<FieldNode['kind'], readonly EditorWidget[]> = {
  string: ['text', 'textarea', 'richtext', 'url', 'date', 'select', 'image'],
  number: ['number'],
  boolean: ['switch'],
  enum: ['select'],
  object: ['group', 'item-ref'],
  array: ['list', 'item-ref-list'],
  unsupported: [],
};

const isItemRefObject = (node: FieldNode): boolean =>
  node.kind === 'object' && node.shape !== undefined && Object.keys(node.shape).length === 1 && '$ref' in node.shape;

function inferWidget(node: FieldNode): EditorWidget {
  switch (node.kind) {
    case 'string':
      if (node.format === 'url') return 'url';
      if (node.format === 'date') return 'date';
      return (node.max ?? 0) > TEXTAREA_THRESHOLD ? 'textarea' : 'text';
    case 'number':
      return 'number';
    case 'boolean':
      return 'switch';
    case 'enum':
      return 'select';
    case 'object':
      return isItemRefObject(node) ? 'item-ref' : 'group';
    case 'array':
      return node.element && (node.element.marker === 'item-ref' || isItemRefObject(node.element)) ? 'item-ref-list' : 'list';
    default:
      throw new Error('An unsupported schema has no widget');
  }
}

type Context = { overrides: Record<string, EditorFieldOverride>; blockTypeKeys: readonly string[]; typeKey: string };

function build(path: string, label: string, node: FieldNode, group: string, context: Context, forceRequired = false): FieldConfig {
  const override = context.overrides[path] ?? {};
  const widget = override.widget ?? node.marker ?? inferWidget(node);
  if (!COMPATIBLE[node.kind].includes(widget)) {
    throw new Error(`The field "${path}" of "${context.typeKey}" cannot use the "${widget}" widget with a ${node.kind} schema.`);
  }
  const required = forceRequired ? true : node.required;
  const common = {
    path,
    label: override.label ?? label,
    ...(override.help !== undefined ? { help: override.help } : {}),
    ...(override.placeholder !== undefined ? { placeholder: override.placeholder } : {}),
    required,
    group: override.group ?? group,
    order: override.order ?? null,
    hidden: override.hidden ?? false,
    readOnly: override.readOnly ?? false,
    ...(node.hasDefault ? { defaultValue: node.defaultValue } : {}),
  };

  switch (widget) {
    case 'text':
    case 'textarea':
    case 'richtext':
    case 'url':
    case 'date':
      return {
        ...common,
        widget,
        ...(node.min !== undefined ? { minLength: node.min } : {}),
        ...(node.max !== undefined ? { maxLength: node.max } : {}),
        ...(override.rows !== undefined && (widget === 'textarea' || widget === 'richtext') ? { rows: override.rows } : {}),
      };
    case 'number':
      return {
        ...common,
        widget,
        integer: node.integer ?? false,
        ...(node.min !== undefined ? { min: node.min } : {}),
        ...(node.max !== undefined ? { max: node.max } : {}),
      };
    case 'switch':
      return { ...common, widget };
    case 'image':
      return { ...common, widget };
    case 'select': {
      const options = override.options ?? (node.options ?? []).map((value) => ({ value, label: value }));
      if (options.length === 0) throw new Error(`The field "${path}" of "${context.typeKey}" is a select with no options.`);
      return { ...common, widget, options };
    }
    case 'item-ref':
      return { ...common, widget, allowedTypeKeys: override.allowedTypeKeys ?? [...context.blockTypeKeys] };
    case 'item-ref-list': {
      const elementOverride = context.overrides[`${path}.*`];
      return {
        ...common,
        widget,
        allowedTypeKeys: override.allowedTypeKeys ?? elementOverride?.allowedTypeKeys ?? [...context.blockTypeKeys],
        ...(node.min !== undefined ? { min: node.min } : {}),
        ...(node.max !== undefined ? { max: node.max } : {}),
      };
    }
    case 'list': {
      const item = build(`${path}.*`, `${common.label} item`, node.element as FieldNode, common.group, context, true);
      return {
        ...common,
        widget,
        item,
        ...(node.min !== undefined ? { min: node.min } : {}),
        ...(node.max !== undefined ? { max: node.max } : {}),
      };
    }
    case 'group':
      return { ...common, widget, fields: buildFields(path, node, common.group, context) };
  }
}

function buildFields(parentPath: string, node: FieldNode, group: string, context: Context): FieldConfig[] {
  const fields: FieldConfig[] = [];
  for (const [name, child] of Object.entries(node.shape ?? {})) {
    // a field the generator cannot build, or a list of them, is left out: a custom type draws it with its own form
    if (child.kind === 'unsupported' || (child.kind === 'array' && child.element?.kind === 'unsupported')) continue;
    fields.push(build(parentPath ? `${parentPath}.${name}` : name, humanise(name), child, group, context));
  }
  return sortByOrder(fields);
}

/** Lower `order` first; fields with no order keep the schema's order after the ordered ones. The sort is stable. */
function sortByOrder(fields: FieldConfig[]): FieldConfig[] {
  return fields
    .map((field, index) => ({ field, index }))
    .sort((a, b) => (a.field.order ?? Infinity) - (b.field.order ?? Infinity) || a.index - b.index)
    .map(({ field }) => field);
}

/**
 * What the generated editor builds its form from: the type's zod schema, then the type's `editor.overrides`. Pure.
 * Fields are ordered by accordion (`editor.groups` first, `Details` ahead of any group the type does not list), then by
 * `order`, then by the schema's own order. A field the generator cannot build (an unsupported schema) is left out: the
 * site's own form for a `custom` type shows it.
 */
export function describeFields(type: ContentType, options: DescribeFieldsOptions = {}): FieldConfig[] {
  const root = analyzeSchema(type.schema);
  if (root.kind !== 'object') return [];
  const context: Context = { overrides: type.editor.overrides, blockTypeKeys: options.blockTypeKeys ?? [], typeKey: type.key };
  const fields = buildFields('', root, DEFAULT_FIELD_GROUP, context);

  const order: string[] = [...type.editor.groups];
  if (!order.includes(DEFAULT_FIELD_GROUP)) order.unshift(DEFAULT_FIELD_GROUP);
  for (const field of fields) if (!order.includes(field.group)) order.push(field.group);
  const rank = (field: FieldConfig) => order.indexOf(field.group);
  return fields.map((field, index) => ({ field, index })).sort((a, b) => rank(a.field) - rank(b.field) || a.index - b.index).map(({ field }) => field);
}
