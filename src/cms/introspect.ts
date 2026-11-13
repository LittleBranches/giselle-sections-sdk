import { z, type ZodType } from 'zod';

import { EDITOR_WIDGETS, type EditorWidget } from './content-type';

/**
 * A neutral reading of a zod schema: just what the registry and the generated editor need to know. Zod's own shapes
 * stop at this file; everything else works on `FieldNode`.
 */
export type FieldNode = {
  kind: 'string' | 'number' | 'boolean' | 'enum' | 'object' | 'array' | 'unsupported';
  /** `false` for an optional, nullable or defaulted schema. */
  required: boolean;
  hasDefault: boolean;
  defaultValue?: unknown;
  /** The widget the schema asks for with `.meta({ widget })`, if it is a widget the editor knows. */
  marker?: EditorWidget;
  /** A string format such as `url` or `date`. */
  format?: string;
  min?: number;
  max?: number;
  integer?: boolean;
  /** The values of an enum or a union of string literals. */
  options?: string[];
  shape?: Record<string, FieldNode>;
  element?: FieldNode;
  /** Why the schema is not supported by the generated editor. */
  reason?: string;
};

type LooseDef = Record<string, any>;
const defOf = (schema: unknown): LooseDef => (schema as { _zod: { def: LooseDef } })._zod.def;
const checkDefs = (def: LooseDef): LooseDef[] =>
  ((def.checks ?? []) as { _zod?: { def: LooseDef }; def?: LooseDef }[]).map((check) => check._zod?.def ?? check.def ?? {});

const isWidget = (value: unknown): value is EditorWidget => EDITOR_WIDGETS.includes(value as EditorWidget);

function stringOptions(def: LooseDef): string[] | null {
  if (def.type === 'literal') return (def.values as unknown[]).every((v) => typeof v === 'string') ? (def.values as string[]) : null;
  if (def.type === 'enum') return Object.values(def.entries as Record<string, unknown>).filter((v): v is string => typeof v === 'string');
  if (def.type === 'union') {
    const all: string[] = [];
    for (const option of def.options as unknown[]) {
      const inner = stringOptions(defOf(option));
      if (!inner) return null;
      all.push(...inner);
    }
    return all;
  }
  return null;
}

/** Reads a zod schema into a `FieldNode` tree. Never throws: what it cannot read becomes `unsupported`. */
export function analyzeSchema(schema: ZodType): FieldNode {
  let required = true;
  let hasDefault = false;
  let defaultValue: unknown;
  let marker: EditorWidget | undefined;
  let current: unknown = schema;

  for (let depth = 0; depth < 25; depth += 1) {
    const meta = z.globalRegistry.get(current as ZodType) as { widget?: unknown } | undefined;
    if (marker === undefined && isWidget(meta?.widget)) marker = meta.widget;
    const def = defOf(current);
    if (def.type === 'optional' || def.type === 'nullable') {
      required = false;
      current = def.innerType;
    } else if (def.type === 'default' || def.type === 'prefault') {
      required = false;
      hasDefault = true;
      defaultValue = def.defaultValue;
      current = def.innerType;
    } else if (def.type === 'readonly' || def.type === 'catch' || def.type === 'nonoptional') {
      current = def.innerType;
    } else if (def.type === 'pipe') {
      if (defOf(def.out).type !== 'transform') return { kind: 'unsupported', required, hasDefault, reason: 'a pipe that is not a plain transform' };
      current = def.in;
    } else {
      break;
    }
  }

  const def = defOf(current);
  const base = { required, hasDefault, ...(hasDefault ? { defaultValue } : {}), ...(marker ? { marker } : {}) };
  const checks = checkDefs(def);

  switch (def.type) {
    case 'string': {
      const node: FieldNode = { kind: 'string', ...base };
      const format = (def.format as string | undefined) ?? undefined;
      if (format) node.format = format;
      for (const check of checks) {
        if (check.check === 'min_length') node.min = Math.max(node.min ?? 0, check.minimum);
        if (check.check === 'max_length') node.max = Math.min(node.max ?? Infinity, check.maximum);
        if (check.check === 'length_equals') {
          node.min = check.length;
          node.max = check.length;
        }
        if (check.check === 'string_format' && !node.format) node.format = String(check.format);
      }
      return node;
    }
    case 'number': {
      const node: FieldNode = { kind: 'number', integer: false, ...base };
      for (const check of checks) {
        if (check.check === 'number_format' && /int/.test(String(check.format))) node.integer = true;
        if (check.check === 'greater_than') node.min = Math.max(node.min ?? -Infinity, check.inclusive ? check.value : check.value + 1);
        if (check.check === 'less_than') node.max = Math.min(node.max ?? Infinity, check.inclusive ? check.value : check.value - 1);
      }
      return node;
    }
    case 'boolean':
      return { kind: 'boolean', ...base };
    case 'enum':
    case 'literal':
    case 'union': {
      const options = stringOptions(def);
      if (!options) return { kind: 'unsupported', ...base, reason: def.type === 'union' ? 'a union that is not made of string literals' : 'a literal that is not a string' };
      return { kind: 'enum', options: [...new Set(options)], ...base };
    }
    case 'object': {
      const shape: Record<string, FieldNode> = {};
      for (const [key, value] of Object.entries(def.shape as Record<string, ZodType>)) shape[key] = analyzeSchema(value);
      return { kind: 'object', shape, ...base };
    }
    case 'array': {
      const node: FieldNode = { kind: 'array', element: analyzeSchema(def.element as ZodType), ...base };
      for (const check of checks) {
        if (check.check === 'min_length') node.min = Math.max(node.min ?? 0, check.minimum);
        if (check.check === 'max_length') node.max = Math.min(node.max ?? Infinity, check.maximum);
        if (check.check === 'length_equals') {
          node.min = check.length;
          node.max = check.length;
        }
      }
      return node;
    }
    case 'lazy':
      return { kind: 'unsupported', ...base, reason: 'a recursive schema' };
    case 'any':
    case 'unknown':
      return { kind: 'unsupported', ...base, reason: 'a schema that accepts anything' };
    default:
      return { kind: 'unsupported', ...base, reason: `a ${String(def.type)} schema` };
  }
}

/** Every unsupported node under `node`, with its dotted path (`*` for a list element). */
export function findUnsupported(node: FieldNode, path = ''): { path: string; reason: string }[] {
  if (node.kind === 'unsupported') return [{ path: path || '(root)', reason: node.reason ?? 'unsupported' }];
  if (node.kind === 'object') return Object.entries(node.shape ?? {}).flatMap(([key, child]) => findUnsupported(child, path ? `${path}.${key}` : key));
  if (node.kind === 'array' && node.element) return findUnsupported(node.element, path ? `${path}.*` : '*');
  return [];
}

/** The node a dotted override path names, or `undefined`. A list element is `*`. */
export function nodeAtPath(root: FieldNode, path: string): FieldNode | undefined {
  let node: FieldNode | undefined = root;
  for (const segment of path.split('.')) {
    if (!node) return undefined;
    if (node.kind === 'object') node = node.shape && Object.prototype.hasOwnProperty.call(node.shape, segment) ? node.shape[segment] : undefined;
    else if (node.kind === 'array' && segment === '*') node = node.element;
    else return undefined;
  }
  return node;
}
