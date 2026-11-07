/**
 * @file career-timeline/types.ts
 * @description Provider/UI-agnostic types for a two-sided career timeline (phases with
 * optional milestones, platform badges, photos, and client logos).
 * @pattern DTO-first: a consuming app (or its provider) supplies plain-data DTOs (icon ids,
 * opaque footer slot ids, etc.) and resolves them into rendered output with its own
 * adapter, typically via `mapTimelinePhaseDto` from `./utils`.
 * @usage import type { TimelinePhaseDto, TimelineMilestoneDto } from '@littlebranches/giselle-sections-sdk'
 *
 * No JSX. No MUI. No personal content. Pure TypeScript — bring your own rendering layer.
 */

/** Background tone for a milestone's timeline dot, resolved to a concrete color by `resolveDotBackground`. */
export type DotBackgroundTone = 'light' | 'dark';

/**
 * A platform/tool badge shown on a timeline phase. A bare string is a plain label;
 * `icon` resolves an icon id via the consumer's own icon renderer, and `logo` points
 * at an image asset (e.g. a company or product logo) instead of an icon.
 */
export type TimelinePlatformDto =
  | string
  | { kind: 'icon'; iconId: string; label: string }
  | { kind: 'logo'; src: string; label: string };

/**
 * A single event on a timeline phase's milestone track.
 *
 * Field-for-field audited against `giselle-mui`'s real `TimelineMilestone` component
 * type (which this SDK cannot import — it would break the "no UI framework dependency"
 * rule) plus its `Task` base type. Every optional field that type declares is
 * represented here, except `children` (recursive nested sub-tasks) — see the note below.
 */
export type TimelineMilestoneDto = {
  date: string;
  shortTitle?: string;
  title: string;
  description?: string;
  iconId: string;
  side?: 'left' | 'right';
  dotBgTone?: DotBackgroundTone;
  details?: string[];
  /** Mirrors `TimelineMilestone.done` — dims the milestone badge and card. */
  done?: boolean;
  /** Mirrors `TimelineMilestone.overdue` — renders the badge in error (red) colour when not done. */
  overdue?: boolean;
  /** Mirrors `TimelineMilestone.new` — renders a "NEW" dot near the title. */
  new?: boolean;
  /** Mirrors `TimelineMilestone.dotTooltip` — overrides the computed spine-dot tooltip. */
  dotTooltip?: string;
  /** Mirrors `TimelineMilestone.anchor` — the name this milestone is opened by (`reveal`) and linked to. */
  anchor?: string;
  // Deliberately excluded: `children` (recursive `Task[]` sub-items). Unused by every
  // known consumer today and would require this SDK to also model an unbounded,
  // self-referential Task DTO shape. Add it if a real consumer ever needs it —
  // don't build it speculatively.
};

/**
 * One checklist step of a timeline phase: a plain sub-item a person can tick off. The SDK never stores whether it is
 * done in a place of its own: `done` only seeds the state when the content already says so.
 */
export type TimelineStepDto = {
  title: string;
  description?: string;
  /** Seeds the step as done. Ticks a person makes later are the consumer's own data, not part of the DTO. */
  done?: boolean;
};

export type TimelinePhotoDto = { src: string; alt: string };

export type TimelineClientDto = { name: string; logo: string };

/**
 * One phase (era, role, project, etc.) in a two-column career timeline. `iconId` and
 * `footerSlot` are opaque identifiers the SDK never interprets — a consumer's own
 * adapter resolves them to rendered output (see `mapTimelinePhaseDto`).
 *
 * Field-for-field audited against `giselle-mui`'s real `TimelinePhase` component type
 * (via its `Task` base type) — every optional field it declares is represented here,
 * except `children` (see `TimelineMilestoneDto`'s note; the same reasoning applies).
 */
export type TimelinePhaseDto = {
  key: number;
  title: string;
  /** Mirrors `TimelinePhase.shortTitle` (inherited from `Task`) — collapsed-card label, falls back to `title`. */
  shortTitle?: string;
  description?: string;
  date?: string;
  color?: string;
  side: 'left' | 'right';
  variant?: string;
  iconId: string;
  /** Opaque slot identifier a consumer resolves to its own rendered footer content (e.g. an audio-button component). The SDK never interprets this string. */
  footerSlot?: string;
  platforms?: TimelinePlatformDto[];
  /** Mirrors `TimelinePhase.platformsLabel` — label shown above the platform-icon strip. */
  platformsLabel?: string;
  milestones?: TimelineMilestoneDto[];
  details?: string[];
  active?: boolean;
  /** Mirrors `TimelinePhase.activeLabel` — label for the pulsing active badge. */
  activeLabel?: string;
  hideDate?: boolean;
  photos?: TimelinePhotoDto[];
  /** Mirrors `TimelinePhase.photo` — a single personal photo, distinct from `photos` (multiple). */
  photo?: TimelinePhotoDto;
  clients?: TimelineClientDto[];
  clientsLabel?: string;
  /** Mirrors `TimelinePhase.projects` — a logo strip for the phase-holder's own projects/side-projects. */
  projects?: TimelineClientDto[];
  /** Mirrors `TimelinePhase.projectsLabel` — label shown above the projects logo strip. */
  projectsLabel?: string;
  /** Mirrors `TimelinePhase.scenarioLabel` — badge label shown when `variant === 'scenario'`. */
  scenarioLabel?: string;
  /** Mirrors `TimelinePhase.overdue` — forces the red past-due dot/connector state. */
  overdue?: boolean;
  /** Mirrors `TimelinePhase.new` — renders a pulsing "NEW" badge on the card. */
  new?: boolean;
  /** Mirrors `TimelinePhase.hideDecoration` — suppresses the card's corner decoration. */
  hideDecoration?: boolean;
  /** Mirrors `TimelinePhase.textAlign` — card content alignment, defaults to `'left'`. */
  textAlign?: 'left' | 'right';
  /** Mirrors `TimelinePhase.dotTooltip` — overrides the computed spine-dot tooltip. */
  dotTooltip?: string;
  /** Mirrors `TimelinePhase.anchor` — the name this phase is opened by (`reveal`) and linked to. */
  anchor?: string;
  /**
   * The phase's checklist steps, in order: plain sub-items a person can tick off. `mapTimelinePhaseDto` resolves
   * them into `children`, keyed by position (`createStableStepKey`), so a consumer that records ticks by position
   * should add new steps at the end.
   */
  steps?: TimelineStepDto[];
  // Deliberately excluded: `children` (recursive `Task[]` sub-items) — see
  // `TimelineMilestoneDto`'s note; the same reasoning applies here.
};

/**
 * Copy for the timeline's sidebar/intro panel.
 *
 * Field-for-field audited against `giselle-mui`'s real `TimelineSidebar` component
 * type. Note: that real type declares `overline` as required; it's kept optional here
 * since the SDK's own `mapTimelinePhaseDto` doesn't touch this type at all — it's
 * plain, already-serializable data with no `ReactNode` fields, so a consumer can
 * import the real component's own type directly instead of this one if it wants the
 * stricter contract.
 */
export type TimelineSidebar = {
  overline?: string;
  heading: string;
  body: string[];
  statusChip?: string;
};

/**
 * Header labels for the timeline's two columns (e.g. "left"/"right" side headings).
 *
 * Field-for-field audited against `giselle-mui`'s real `TimelineColumnLabels`
 * component type.
 */
export type TimelineColumnLabels = {
  left: string;
  /** Mirrors `TimelineColumnLabels.leftSubtitle` — optional short-description line below the left label. */
  leftSubtitle?: string;
  right: string;
  /** Mirrors `TimelineColumnLabels.rightSubtitle` — optional short-description line below the right label. */
  rightSubtitle?: string;
};
