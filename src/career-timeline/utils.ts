/**
 * @file career-timeline/utils.ts
 * @description Pure helpers for turning career-timeline DTOs into stable keys
 * and consumer-rendered shapes. No JSX, no framework imports — `mapTimelinePhaseDto`
 * takes the consumer's own render functions and stays framework-agnostic.
 * @usage import { mapTimelinePhaseDto, createStableMilestoneKey } from '@littlebranches/giselle-sections-sdk'
 */

import type {
  DotBackgroundTone,
  TimelineMilestoneDto,
  TimelinePhaseDto,
  TimelinePlatformDto,
  TimelineStepDto,
} from './types';

/** Lowercase, collapse anything that isn't `[a-z0-9]` into a single hyphen, and trim leading/trailing hyphens. */
const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * Builds a stable, human-readable React key for a milestone, derived from its phase
 * key, date, and title (preferring `shortTitle` when present) rather than array index —
 * so the key survives reordering and content edits.
 */
export function createStableMilestoneKey(
  phaseKey: number,
  milestone: Pick<TimelineMilestoneDto, 'shortTitle' | 'title' | 'date'>
): string {
  const titleToken = slugify(milestone.shortTitle ?? milestone.title);
  const dateToken = slugify(milestone.date);
  return `${phaseKey}-ms-${dateToken}-${titleToken}`;
}

/**
 * Builds the key of a checklist step from its phase key and its position. Unlike a milestone's key it is positional,
 * since a step is a bare title that may be reworded: ticks recorded against it stay put as long as new steps are
 * added at the end.
 */
export function createStableStepKey(phaseKey: number, stepIndex: number): string {
  return `${phaseKey}-${stepIndex}`;
}

/** Resolves a milestone dot's background tone to a concrete color, or `undefined` when unset. */
export function resolveDotBackground(tone?: DotBackgroundTone): string | undefined {
  if (tone === 'light') return '#fff';
  if (tone === 'dark') return '#111';
  return undefined;
}

/** Builds an icon-backed platform DTO entry. */
export function createPlatformIconItem(iconId: string, label: string): TimelinePlatformDto {
  return { kind: 'icon', iconId, label };
}

/** Builds a logo-backed platform DTO entry. */
export function createPlatformLogoItem(src: string, label: string): TimelinePlatformDto {
  return { kind: 'logo', src, label };
}

/**
 * Render functions a consumer supplies to turn DTO identifiers into its own
 * rendered output. `resolveFooter` is optional since not every phase has a footer slot.
 */
export type TimelinePhaseRenderers<TIcon, TPlatformItem, TFooter> = {
  renderIcon: (iconId: string) => TIcon;
  renderPlatform: (platform: TimelinePlatformDto) => TPlatformItem;
  resolveFooter?: (footerSlot?: string) => TFooter | undefined;
};

/** A `TimelineMilestoneDto` with its opaque fields resolved to consumer-rendered output. */
export type MappedTimelineMilestone<TIcon> = Omit<TimelineMilestoneDto, 'iconId' | 'dotBgTone'> & {
  key: string;
  icon: TIcon;
  dotBg?: string;
};

/** A `TimelinePhaseDto` with its opaque fields resolved to consumer-rendered output. */
export type MappedTimelinePhase<TIcon, TPlatformItem, TFooter> = Omit<
  TimelinePhaseDto,
  'iconId' | 'footerSlot' | 'platforms' | 'milestones' | 'steps'
> & {
  icon: TIcon;
  footer?: TFooter;
  platforms?: TPlatformItem[];
  milestones?: Array<MappedTimelineMilestone<TIcon>>;
  /** The phase's `steps`, resolved: a key from the phase and the step's position, and the step's own fields. */
  children?: Array<TimelineStepDto & { key: string }>;
};

/**
 * Maps a `TimelinePhaseDto` into a fully-rendered phase by resolving every opaque
 * identifier (`iconId`, `footerSlot`, platform/milestone DTOs) through the supplied
 * `renderers`. This is the one adapter both consumer apps previously hand-rolled;
 * generic `TIcon`/`TPlatformItem`/`TFooter` type parameters let each consumer plug in
 * its own rendered types (JSX elements, component descriptors, etc.) without the SDK
 * knowing or caring what they are.
 */
export function mapTimelinePhaseDto<TIcon, TPlatformItem, TFooter>(
  phaseDto: TimelinePhaseDto,
  renderers: TimelinePhaseRenderers<TIcon, TPlatformItem, TFooter>
): MappedTimelinePhase<TIcon, TPlatformItem, TFooter> {
  const { iconId, footerSlot, platforms, milestones, steps, ...restPhase } = phaseDto;
  const { renderIcon, renderPlatform, resolveFooter } = renderers;

  return {
    ...restPhase,
    icon: renderIcon(iconId),
    footer: resolveFooter?.(footerSlot),
    platforms: platforms?.map(renderPlatform),
    children: steps?.map((step, index) => ({ ...step, key: createStableStepKey(phaseDto.key, index) })),
    milestones: milestones?.map((milestone) => {
      const { iconId: milestoneIconId, dotBgTone, ...restMilestone } = milestone;
      return {
        ...restMilestone,
        key: createStableMilestoneKey(phaseDto.key, milestone),
        icon: renderIcon(milestoneIconId),
        dotBg: resolveDotBackground(dotBgTone),
      };
    }),
  };
}
