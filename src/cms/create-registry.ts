import { ContentValidationError } from '../content/errors';
import { contentTypeDefinitionSchema, type ContentType, type ContentTypeInput } from './content-type';
import { describeFields } from './describe-fields';
import { analyzeSchema, findUnsupported, nodeAtPath } from './introspect';
import { MAX_ITEMS_PER_SLOT } from './page-layout';
import type { ContentTypeRegistry } from './registry';

function fail(message: string, issues: string[] = [message]): never {
  throw new ContentValidationError(message, issues);
}

/**
 * The registry a site fills once at start-up: it checks each type as it is registered (schema, editor overrides, slot
 * limits) and, when `validate()` is called after all types are in, that every key a slot or a picker names is a
 * registered document block type.
 */
export function createContentTypeRegistry(): ContentTypeRegistry {
  const types = new Map<string, ContentType>();

  return {
    register<T>(input: ContentTypeInput<T>): ContentType<T> {
      const parsed = contentTypeDefinitionSchema.safeParse(input);
      if (!parsed.success) {
        const key = typeof (input as { key?: unknown })?.key === 'string' ? (input as { key: string }).key : '(no key)';
        const issues = parsed.error.issues.map((issue) => `${issue.path.map(String).join('.') || '(type)'}: ${issue.message}`);
        throw new ContentValidationError(`The content type "${key}" is not valid: ${issues.join('; ')}`, issues);
      }
      const type = parsed.data as ContentType<T>;
      if (types.has(type.key)) fail(`The content type "${type.key}" is already registered.`);

      for (const slot of type.slots) {
        if (slot.max !== null && slot.max > MAX_ITEMS_PER_SLOT) {
          fail(`The slot "${slot.key}" of "${type.key}" allows ${slot.max} items; the most a slot can hold is ${MAX_ITEMS_PER_SLOT}.`);
        }
        if (slot.min > MAX_ITEMS_PER_SLOT) {
          fail(`The slot "${slot.key}" of "${type.key}" needs ${slot.min} items; the most a slot can hold is ${MAX_ITEMS_PER_SLOT}.`);
        }
      }

      const root = analyzeSchema(type.schema);
      if (!type.editor.custom) {
        if (root.kind !== 'object') fail(`The schema of "${type.key}" must be an object, or the type must be marked editor.custom.`);
        const unsupported = findUnsupported(root);
        if (unsupported.length > 0) {
          const issues = unsupported.map((entry) => `${entry.path}: ${entry.reason} is not supported by the generated editor`);
          throw new ContentValidationError(
            `The schema of "${type.key}" has fields the generated editor cannot build (mark the type editor.custom to use your own form): ${issues.join('; ')}`,
            issues,
          );
        }
      }

      for (const path of Object.keys(type.editor.overrides)) {
        if (!nodeAtPath(root, path)) fail(`The editor override "${path}" of "${type.key}" names no field of its schema.`);
      }

      if (root.kind === 'object') {
        try {
          describeFields(type);
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
      }

      types.set(type.key, type);
      return type;
    },

    get: (key) => types.get(key),

    require(key) {
      const type = types.get(key);
      if (!type) throw new Error(`There is no content type "${key}".`);
      return type;
    },

    validate() {
      const issues: string[] = [];
      const checkKey = (where: string, key: string) => {
        const target = types.get(key);
        if (!target) issues.push(`${where} names "${key}", which is not registered.`);
        else if (target.kind !== 'block' || target.storage !== 'document') issues.push(`${where} names "${key}", which is not a document block type.`);
      };
      for (const type of types.values()) {
        for (const slot of type.slots) for (const key of slot.allowedTypeKeys) checkKey(`The slot "${slot.key}" of "${type.key}"`, key);
        for (const [path, override] of Object.entries(type.editor.overrides)) {
          for (const key of override.allowedTypeKeys ?? []) checkKey(`The editor override "${path}" of "${type.key}"`, key);
        }
      }
      if (issues.length > 0) throw new ContentValidationError(`The registry is not consistent: ${issues.join(' ')}`, issues);
    },

    list(filter) {
      return [...types.values()].filter((type) => (!filter?.kind || type.kind === filter.kind) && (!filter?.storage || type.storage === filter.storage));
    },
  };
}
