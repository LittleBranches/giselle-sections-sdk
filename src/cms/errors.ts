import type { CollectionRecord, ItemUsage } from './item';

/**
 * The error codes the database functions raise, one per refusal. The Supabase store maps each to the error class
 * beside it; `CE001` is the code the existing entries functions already use for a stale save.
 *
 * `ContentConflictError` and `ContentValidationError` come from the content module and are reused as they are: a stale
 * save of an item or a layout is a `ContentConflictError` whose `current` is the newest version.
 */
export const CMS_ERROR_CODES = {
  /** A stale save or publish. Detail: the newest version as JSON. -> `ContentConflictError` */
  stale: 'CE001',
  /** The caller's role does not allow it. -> `ContentPermissionError` */
  permission: '42501',
  /** A malformed argument, or content that is not an object. -> `ContentValidationError` */
  invalid: '22023',
  /** The item, layout, template or asset does not exist. -> `ContentNotFoundError` */
  notFound: 'CM001',
  /** The item is still referenced. Detail: the usages as a JSON array. -> `ContentReferencedError` */
  referenced: 'CM002',
  /** A reference points at an item that does not exist. Detail: the missing ids as JSON. -> `ContentReferenceError` */
  danglingReference: 'CM003',
  /** A layout breaks a slot rule (type not allowed, too many items, unknown template or slot). Detail: the problems as JSON. -> `LayoutRuleError` */
  slotRule: 'CM004',
  /** A reference to an item that is not reusable and is already used elsewhere. Detail: the ids as JSON. -> `ContentReferenceError` */
  notReusable: 'CM005',
  /** The file is not in the bucket, or its path or type is not allowed. -> `ContentValidationError` */
  assetInvalid: 'CM006',
  /** A publish of a layout that does not meet a slot's minimum. Detail: the problems as JSON. -> `LayoutRuleError` */
  layoutIncomplete: 'CM007',
  /** A reference that would make an item reach itself through other items. Detail: the ids on the cycle as JSON. -> `ContentReferenceError` (`cycle`) */
  cycle: 'CM008',
} as const;
export type CmsErrorCode = (typeof CMS_ERROR_CODES)[keyof typeof CMS_ERROR_CODES];

/** Thrown when an item, layout, template or asset is not there. */
export class ContentNotFoundError extends Error {
  readonly kind: 'item' | 'layout' | 'template' | 'asset';
  readonly id: string;

  constructor(kind: 'item' | 'layout' | 'template' | 'asset', id: string) {
    super(`There is no ${kind} "${id}".`);
    this.name = 'ContentNotFoundError';
    this.kind = kind;
    this.id = id;
  }
}

/** Thrown when the caller's role does not allow the call. A visitor's draft read does not throw: it finds nothing. */
export class ContentPermissionError extends Error {
  constructor(message = 'You are not allowed to do that.') {
    super(message);
    this.name = 'ContentPermissionError';
  }
}

/** Thrown when deleting an item that is still referenced. Nothing was deleted; `usages` lists where it is used. */
export class ContentReferencedError extends Error {
  readonly itemId: string;
  readonly usages: ItemUsage[];

  constructor(itemId: string, usages: ItemUsage[]) {
    super(`This item is still used in ${usages.length} place${usages.length === 1 ? '' : 's'}: it was not deleted.`);
    this.name = 'ContentReferencedError';
    this.itemId = itemId;
    this.usages = usages;
  }
}

/** Thrown when a save refers to items that are missing, to a non-reusable item used elsewhere, or in a circle. Nothing was saved. */
export class ContentReferenceError extends Error {
  readonly reason: 'missing' | 'not-reusable' | 'cycle';
  readonly itemIds: string[];

  constructor(reason: 'missing' | 'not-reusable' | 'cycle', itemIds: string[]) {
    super(
      reason === 'cycle'
        ? 'These items would refer to each other in a circle. Nothing was saved.'
        : reason === 'missing'
        ? `This refers to ${itemIds.length} item${itemIds.length === 1 ? '' : 's'} that no longer exist. Nothing was saved.`
        : `${itemIds.length === 1 ? 'An item' : 'Some items'} cannot be used in a second place because ${itemIds.length === 1 ? 'it is' : 'they are'} not marked reusable. Nothing was saved.`,
    );
    this.name = 'ContentReferenceError';
    this.reason = reason;
    this.itemIds = itemIds;
  }
}

/** Thrown when a layout breaks a template's slot rules. One line per problem, naming the section and slot. */
export class LayoutRuleError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = 'LayoutRuleError';
    this.issues = issues;
  }
}

/** Thrown when a collection record changed since it was opened. `current` is the stored record. */
export class CollectionConflictError<T = unknown> extends Error {
  readonly current: CollectionRecord<T>;

  constructor(current: CollectionRecord<T>) {
    super('This record changed since you opened it. Nothing was saved.');
    this.name = 'CollectionConflictError';
    this.current = current;
  }
}
