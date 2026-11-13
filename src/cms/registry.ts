import type { ContentKind, ContentType, ContentTypeInput, StorageKind } from './content-type';

/**
 * The shape of the registry: it binds a content type to the key of a library component. It has no component code
 * because the SDK has no React; a site resolves a component key to a component with its own `ComponentResolver`.
 * Implemented in WP1 as `createContentTypeRegistry()`; one registry per site, filled once at start-up.
 */
export interface ContentTypeRegistry {
  /**
   * Validates the input against `contentTypeDefinitionSchema`, checks every editor override path against the type's
   * schema, and stores the type. Throws on an invalid input and on a key that is already registered. Returns the type
   * as stored (defaults filled in).
   */
  register<T>(input: ContentTypeInput<T>): ContentType<T>;
  /** The type with this key, or `undefined`. */
  get(key: string): ContentType | undefined;
  /** The type with this key; throws if there is none. */
  require(key: string): ContentType;
  /**
   * Checks what can only be checked once every type is registered: that every `allowedTypeKeys` of a container's slots
   * names a registered block type. Throws with one line per problem. A site calls it once, after registering.
   */
  validate(): void;
  /** Every type, in registration order, optionally narrowed. */
  list(filter?: { kind?: ContentKind; storage?: StorageKind }): readonly ContentType[];
}

/**
 * What a site supplies to turn the `component` key of a type into something it can render. `C` is the site's component
 * type (a React component, in the sites). The SDK never calls it.
 */
export interface ComponentResolver<C = unknown> {
  resolve(componentKey: string): C | undefined;
}
