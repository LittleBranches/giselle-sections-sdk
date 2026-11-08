import type { ContentVersionRecord } from './store';

/** Thrown when content does not match its section's schema, on save or on read. The message is safe to show to a person. */
export class ContentValidationError extends Error {
  /** One line per problem, each naming the field it is about, e.g. `sources.2.href: Invalid URL`. */
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = 'ContentValidationError';
    this.issues = issues;
  }
}

/**
 * Thrown when a write was based on a version that is no longer the newest: somebody saved in between. Nothing was
 * written. `current` is the newest version, so the person can see what the other save changed and merge by hand.
 */
export class ContentConflictError extends Error {
  readonly current: ContentVersionRecord;

  constructor(current: ContentVersionRecord) {
    super(`This entry changed since you opened it: it is now at version ${current.version}. Nothing was saved.`);
    this.name = 'ContentConflictError';
    this.current = current;
  }
}
