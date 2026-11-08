import type { TimelinePhaseDto } from '../career-timeline';

/**
 * Where a timeline's phases come from. The SDK defines the shape it needs and knows nothing about the backend: a
 * database, a headless CMS, a GraphQL API or a hand-written list each implement this, and an app swaps one for another
 * without changing anything that renders. The provider returns DTOs; `mapTimelinePhaseDto` turns them into the view
 * models a component renders.
 */
export interface TimelineDataProvider {
  getTimelinePhases(): Promise<TimelinePhaseDto[]>;
}

/**
 * A provider over a fixed list of phases, for content that lives in the app's own code and for tests. It hands back a
 * copy each time, so a caller cannot change what the provider holds.
 */
export function createStaticTimelineProvider(phases: readonly TimelinePhaseDto[]): TimelineDataProvider {
  return {
    getTimelinePhases: async () => [...phases],
  };
}

/** The longest phase title the provider accepts, in characters. */
export const MAX_TIMELINE_PHASE_TITLE_LENGTH = 200;

/** Thrown when a value handed to a provider's write method is not acceptable. The message is safe to show to a person. */
export class TimelineValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimelineValidationError';
  }
}

/**
 * Checks a phase title on its way in and returns it trimmed. A title must be text, not blank, and at most
 * `MAX_TIMELINE_PHASE_TITLE_LENGTH` characters. Every provider that writes titles calls this first, so the same rule
 * holds whatever the backend is.
 */
export function parseTimelinePhaseTitle(value: unknown): string {
  if (typeof value !== 'string') throw new TimelineValidationError('The title must be text.');
  const title = value.trim();
  if (title === '') throw new TimelineValidationError('The title cannot be empty.');
  if (title.length > MAX_TIMELINE_PHASE_TITLE_LENGTH) {
    throw new TimelineValidationError(`The title can be at most ${MAX_TIMELINE_PHASE_TITLE_LENGTH} characters.`);
  }
  return title;
}

/**
 * A timeline provider that can also change content. The write side is a separate interface so a read-only provider
 * stays valid; a backend that supports editing implements both. Who is allowed to write is the backend's decision (a
 * database's own rules, for instance): a refused write rejects rather than silently doing nothing.
 */
export interface WritableTimelineDataProvider extends TimelineDataProvider {
  /** Changes the title of the phase with this key. Rejects with `TimelineValidationError` if the title is not valid. */
  updateTimelinePhaseTitle(phaseKey: number, title: string): Promise<void>;
}
