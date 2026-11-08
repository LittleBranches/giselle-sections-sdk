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

/** The longest phase short title, description and date, and task title, in characters. */
export const MAX_TIMELINE_PHASE_SHORT_TITLE_LENGTH = 100;
export const MAX_TIMELINE_PHASE_DESCRIPTION_LENGTH = 2000;
export const MAX_TIMELINE_PHASE_DATE_LENGTH = 100;
export const MAX_TIMELINE_TASK_TITLE_LENGTH = 500;

/** The editable text fields of a phase. An empty optional field is saved as "no value" (`null`). */
export type TimelinePhaseFields = {
  title: string;
  shortTitle: string | null;
  description: string | null;
  date: string | null;
};

function requiredText(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string') throw new TimelineValidationError(`The ${name} must be text.`);
  const text = value.trim();
  if (text === '') throw new TimelineValidationError(`The ${name} cannot be empty.`);
  if (text.length > max) throw new TimelineValidationError(`The ${name} can be at most ${max} characters.`);
  return text;
}

function optionalText(value: unknown, name: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new TimelineValidationError(`The ${name} must be text.`);
  const text = value.trim();
  if (text === '') return null;
  if (text.length > max) throw new TimelineValidationError(`The ${name} can be at most ${max} characters.`);
  return text;
}

/**
 * Checks a phase's editable fields on their way in and returns them trimmed. The title is required; the short title,
 * description and date are optional, and a blank one becomes `null`. Every provider that writes phases calls this first.
 */
export function parseTimelinePhaseFields(value: unknown): TimelinePhaseFields {
  if (typeof value !== 'object' || value === null) throw new TimelineValidationError('The phase must be an object.');
  const fields = value as Record<string, unknown>;
  return {
    title: requiredText(fields.title, 'title', MAX_TIMELINE_PHASE_TITLE_LENGTH),
    shortTitle: optionalText(fields.shortTitle, 'short title', MAX_TIMELINE_PHASE_SHORT_TITLE_LENGTH),
    description: optionalText(fields.description, 'description', MAX_TIMELINE_PHASE_DESCRIPTION_LENGTH),
    date: optionalText(fields.date, 'date', MAX_TIMELINE_PHASE_DATE_LENGTH),
  };
}

/** Checks a task title on its way in and returns it trimmed: text, not blank, at most `MAX_TIMELINE_TASK_TITLE_LENGTH`. */
export function parseTimelineTaskTitle(value: unknown): string {
  return requiredText(value, 'task title', MAX_TIMELINE_TASK_TITLE_LENGTH);
}

/**
 * Checks an ordered list of ids (task ids or phase keys) handed to a reorder call: a list of whole numbers with no
 * repeats. Whether it names exactly the right items is the backend's to check against what it holds.
 */
export function parseTimelineOrder(value: unknown): number[] {
  if (!Array.isArray(value) || !value.every((id) => Number.isInteger(id))) {
    throw new TimelineValidationError('The order must be a list of ids.');
  }
  if (new Set(value).size !== value.length) throw new TimelineValidationError('The order lists an item more than once.');
  return value as number[];
}

/**
 * A timeline provider that can also change content. The write side is a separate interface so a read-only provider
 * stays valid; a backend that supports editing implements both. Who is allowed to write is the backend's decision (a
 * database's own rules, for instance): a refused write rejects rather than silently doing nothing.
 *
 * Ids are the backend's: a task or phase added gets a fresh one, a removed one is never handed out again, and the order
 * of tasks and phases is independent of their ids. A value that is not acceptable rejects with `TimelineValidationError`.
 */
export interface WritableTimelineDataProvider extends TimelineDataProvider {
  /** Changes the title of the phase with this key. Rejects with `TimelineValidationError` if the title is not valid. */
  updateTimelinePhaseTitle(phaseKey: number, title: string): Promise<void>;

  /** Changes every editable text field of a phase at once (see `parseTimelinePhaseFields`). */
  updateTimelinePhase(phaseKey: number, fields: TimelinePhaseFields): Promise<void>;

  /** Adds a phase at the end of the plan and returns its new key. */
  addTimelinePhase(fields: TimelinePhaseFields): Promise<number>;

  /** Removes a phase and its tasks. */
  removeTimelinePhase(phaseKey: number): Promise<void>;

  /** Puts the phases in this order. The list must name every phase exactly once. */
  reorderTimelinePhases(phaseKeys: number[]): Promise<void>;

  /** Adds a task at the end of a phase and returns its new id. */
  addTimelineTask(phaseKey: number, title: string): Promise<number>;

  /** Changes a task's title. */
  updateTimelineTaskTitle(taskId: number, title: string): Promise<void>;

  /** Removes a task. */
  removeTimelineTask(taskId: number): Promise<void>;

  /** Puts a phase's tasks in this order. The list must name every task of the phase exactly once. */
  reorderTimelineTasks(phaseKey: number, taskIds: number[]): Promise<void>;
}
