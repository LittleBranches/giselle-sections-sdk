import type { PageLayoutContent } from './page-layout';

/**
 * Every `{ "$ref": id }` marker in a piece of content, once each, in the order first met. A marker is any object that
 * has a string `$ref`; its contents are not searched further. The database trusts this list, so it is collected from
 * content that has already been checked against the type's schema.
 */
export function collectItemRefs(content: unknown): string[] {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
    } else if (typeof value === 'object' && value !== null) {
      const marker = (value as Record<string, unknown>)['$ref'];
      if (typeof marker === 'string') {
        found.add(marker);
        return;
      }
      for (const entry of Object.values(value)) walk(entry);
    }
  };
  walk(content);
  return [...found];
}

/** Every item id in the slots of a page layout's sections, once each, in page order. */
export function collectLayoutItemIds(content: PageLayoutContent): string[] {
  const found = new Set<string>();
  for (const section of content.sections) {
    for (const ids of Object.values(section.slots)) for (const id of ids) found.add(id);
  }
  return [...found];
}
