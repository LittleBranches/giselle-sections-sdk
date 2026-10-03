/**
 * @file career-timeline/utils.ts
 * @description Pure helpers for turning career-timeline draft data into stable keys
 * and consumer-rendered shapes. No JSX, no framework imports — `mapTimelinePhaseDraft`
 * takes the consumer's own render functions and stays framework-agnostic.
 * @usage import { mapTimelinePhaseDraft, createStableMilestoneKey } from '@alexrebula/giselle-sections-data'
 */

import type {
  DotBackgroundTone,
  TimelineMilestoneDraft,
  TimelinePhaseDraft,
  TimelinePlatformDraft,
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
  milestone: Pick<TimelineMilestoneDraft, 'shortTitle' | 'title' | 'date'>
): string {
  const titleToken = slugify(milestone.shortTitle ?? milestone.title);
  const dateToken = slugify(milestone.date);
  return `${phaseKey}-ms-${dateToken}-${titleToken}`;
}

/** Resolves a milestone dot's background tone to a concrete color, or `undefined` when unset. */
export function resolveDotBackground(tone?: DotBackgroundTone): string | undefined {
  if (tone === 'light') return '#fff';
  if (tone === 'dark') return '#111';
  return undefined;
}

/** Builds an icon-backed platform draft entry. */
export function createPlatformIconItem(iconId: string, label: string): TimelinePlatformDraft {
  return { kind: 'icon', iconId, label };
}

/** Builds a logo-backed platform draft entry. */
export function createPlatformLogoItem(src: string, label: string): TimelinePlatformDraft {
  return { kind: 'logo', src, label };
}

/**
 * Render functions a consumer supplies to turn draft-layer identifiers into its own
 * rendered output. `resolveFooter` is optional since not every phase has a footer slot.
 */
export type TimelinePhaseRenderers<TIcon, TPlatformItem, TFooter> = {
  renderIcon: (iconId: string) => TIcon;
  renderPlatform: (platform: TimelinePlatformDraft) => TPlatformItem;
  resolveFooter?: (footerSlot?: string) => TFooter | undefined;
};

/** A `TimelineMilestoneDraft` with its opaque fields resolved to consumer-rendered output. */
export type MappedTimelineMilestone<TIcon> = Omit<TimelineMilestoneDraft, 'iconId' | 'dotBgTone'> & {
  key: string;
  icon: TIcon;
  dotBg?: string;
};

/** A `TimelinePhaseDraft` with its opaque fields resolved to consumer-rendered output. */
export type MappedTimelinePhase<TIcon, TPlatformItem, TFooter> = Omit<
  TimelinePhaseDraft,
  'iconId' | 'footerSlot' | 'platforms' | 'milestones'
> & {
  icon: TIcon;
  footer?: TFooter;
  platforms?: TPlatformItem[];
  milestones?: Array<MappedTimelineMilestone<TIcon>>;
};

/**
 * Maps a `TimelinePhaseDraft` into a fully-rendered phase by resolving every opaque
 * identifier (`iconId`, `footerSlot`, platform/milestone drafts) through the supplied
 * `renderers`. This is the one adapter both consumer apps previously hand-rolled;
 * generic `TIcon`/`TPlatformItem`/`TFooter` type parameters let each consumer plug in
 * its own rendered types (JSX elements, component descriptors, etc.) without the SDK
 * knowing or caring what they are.
 */
export function mapTimelinePhaseDraft<TIcon, TPlatformItem, TFooter>(
  phaseDraft: TimelinePhaseDraft,
  renderers: TimelinePhaseRenderers<TIcon, TPlatformItem, TFooter>
): MappedTimelinePhase<TIcon, TPlatformItem, TFooter> {
  const { iconId, footerSlot, platforms, milestones, ...restPhase } = phaseDraft;
  const { renderIcon, renderPlatform, resolveFooter } = renderers;

  return {
    ...restPhase,
    icon: renderIcon(iconId),
    footer: resolveFooter?.(footerSlot),
    platforms: platforms?.map(renderPlatform),
    milestones: milestones?.map((milestone) => {
      const { iconId: milestoneIconId, dotBgTone, ...restMilestone } = milestone;
      return {
        ...restMilestone,
        key: createStableMilestoneKey(phaseDraft.key, milestone),
        icon: renderIcon(milestoneIconId),
        dotBg: resolveDotBackground(dotBgTone),
      };
    }),
  };
}
