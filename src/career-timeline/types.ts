/**
 * @file career-timeline/types.ts
 * @description Provider/UI-agnostic types for a two-sided career timeline (phases with
 * optional milestones, platform badges, photos, and client logos).
 * @pattern Draft-first: a consuming app authors plain-data "draft" shapes (icon ids,
 * opaque footer slot ids, etc.) and resolves them into rendered output with its own
 * adapter, typically via `mapTimelinePhaseDraft` from `./utils`.
 * @usage import type { TimelinePhaseDraft, TimelineMilestoneDraft } from '@alexrebula/giselle-sections-data'
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
export type TimelinePlatformDraft =
  | string
  | { kind: 'icon'; iconId: string; label: string }
  | { kind: 'logo'; src: string; label: string };

/** A single event on a timeline phase's milestone track. */
export type TimelineMilestoneDraft = {
  date: string;
  shortTitle?: string;
  title: string;
  description?: string;
  iconId: string;
  side?: 'left' | 'right';
  dotBgTone?: DotBackgroundTone;
  details?: string[];
};

export type TimelinePhotoDraft = { src: string; alt: string };

export type TimelineClientDraft = { name: string; logo: string };

/**
 * One phase (era, role, project, etc.) in a two-column career timeline. `iconId` and
 * `footerSlot` are opaque identifiers the SDK never interprets — a consumer's own
 * adapter resolves them to rendered output (see `mapTimelinePhaseDraft`).
 */
export type TimelinePhaseDraft = {
  key: number;
  title: string;
  description?: string;
  date?: string;
  color?: string;
  side: 'left' | 'right';
  variant?: string;
  iconId: string;
  /** Opaque slot identifier a consumer resolves to its own rendered footer content (e.g. an audio-button component). The SDK never interprets this string. */
  footerSlot?: string;
  platforms?: TimelinePlatformDraft[];
  milestones?: TimelineMilestoneDraft[];
  details?: string[];
  active?: boolean;
  hideDate?: boolean;
  photos?: TimelinePhotoDraft[];
  clients?: TimelineClientDraft[];
  clientsLabel?: string;
};

/** Copy for the timeline's sidebar/intro panel. */
export type TimelineSidebar = {
  overline?: string;
  heading: string;
  body: string[];
  statusChip?: string;
};

/** Header labels for the timeline's two columns (e.g. "left"/"right" side headings). */
export type TimelineColumnLabels = {
  left: string;
  right: string;
};
