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
