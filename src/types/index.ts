/**
 * @file types/index.ts
 * @description Centralized type definitions for all reusable section components.
 * @pattern Props-based data flow: View owns data → passes typed props to section components.
 * @usage import type { ... } from '@alexrebula/giselle-sections-data'
 *
 * React-first: types use React.ReactNode where content can be rich.
 * No JSX. No MUI. Pure TypeScript — bring your own styling layer.
 */

import type { ReactNode } from 'react';

// ============================================================================
// BASE SECTION TYPES
// ============================================================================

export type BaseSectionProps = {
  caption?: string;
  title?: string;
  txtGradient?: string;
  description?: string | ReactNode;
};

export type SectionImageProps = {
  key?: string;
  alt: string;
  src: string;
};

export type SectionButtonProps = {
  label: string;
  href: string;
  variant?: 'contained' | 'outlined';
  color?: 'inherit' | 'primary' | 'secondary' | 'error' | 'warning' | 'info' | 'success';
};

export type SectionIconButtonProps = SectionButtonProps & {
  icon?: string;
};

export type SectionItemBase = {
  id: string;
  title: string;
  description?: string | ReactNode;
};

export type SectionIconItem = SectionItemBase & {
  icon: string;
};

export type SectionFeaturedItem = SectionItemBase & {
  featured?: boolean;
  subtitle?: string;
};

export type SectionImageItem = SectionItemBase & {
  imgUrl?: string;
};

// ============================================================================
// HOME SECTION TYPES
// ============================================================================

export type HeroAvatarProps = {
  key: string;
  alt: string;
  src: string;
};

export type HomeHeroProps = BaseSectionProps & {
  subheading: string;
  highlightedText?: string;
  imageUrl: string;
  highlights: string[];
  buttons: SectionButtonProps[];
  iconsTitle?: string;
  icons: string[];
  avatar: HeroAvatarProps;
  avatars?: HeroAvatarProps[];
};

export type HomeItemProps = SectionIconItem & {
  subtitle?: string;
  imgUrl?: string;
};

export type ExpertiseAreasProps = BaseSectionProps & {
  items?: HomeItemProps[];
  image?: SectionImageProps;
  layoutDirection?: 'left' | 'right';
  expertiseSections?: ExpertiseAreasProps[];
};

export type HomeIntegrationsProps = BaseSectionProps & {
  caption?: string;
  imgUrl?: string;
  description?: string | ReactNode;
};

export type TestimonialItemProps = {
  id: string;
  rating?: number;
  name: string;
  category?: string;
  content: string | ReactNode;
  postedAt?: string;
  avatar?: SectionImageProps;
};

export type HomeTestimonialsProps = BaseSectionProps & {
  items?: TestimonialItemProps[];
};

export type FAQItemProps = {
  question: string;
  answer: string | ReactNode;
};

export type HomeFAQsProps = BaseSectionProps & {
  faqs?: FAQItemProps[];
};

// ============================================================================
// SERVICES SECTION TYPES
// ============================================================================

export type ServicePackageProps = {
  title: string;
  price: string;
  summary: string;
  featured?: boolean;
  inclusions: string[];
};

export type DesignAddOnProps = {
  title: string;
  cost: string;
};

export type DeliveryStepProps = {
  title: string;
  detail: string;
};

export type ServiceDeliverableProps = SectionIconItem & {
  description: string;
};

export type ServiceProcessItemProps = SectionIconItem & {
  description: string;
};

export type FaqToolLink = {
  label: string;
  href: string;
  icon: string;
};

export type HomeFaqToolLink = FaqToolLink;

export type ServicesFaqToolLink = FaqToolLink;

export type HomeFaqSchemaItem = {
  question: string;
  paragraphs: ReactNode[];
  tools?: FaqToolLink[];
  actions?: Array<{
    label: string;
    href: string;
    variant: 'contained' | 'outlined';
    color?: 'inherit';
    target?: '_blank';
    rel?: 'noopener';
  }>;
};

export type ServicesFaqSchemaItem = {
  question: string;
  paragraphs: string[];
  tools?: FaqToolLink[];
};

// ============================================================================
// ABOUT SECTION TYPES
// ============================================================================

export type AboutHeroClientLogoProps = {
  name: string;
  file: string;
};

export type AboutHeroDataProps = {
  heading: string;
  intro: string | ReactNode;
  statement: string | ReactNode;
  experience?: string;
  assetsDir?: string;
  clientLogos?: AboutHeroClientLogoProps[];
  backgroundImageUrl?: string;
  backgroundOverlay?: string;
  cta?: SectionButtonProps;
};

export type AboutHeroProps = AboutHeroDataProps & BaseSectionProps;

// ============================================================================
// GENERIC REUSABLE PATTERNS
// ============================================================================

export type GridItemProps<T = Record<string, unknown>> = {
  id: string;
  title: string;
  content: string | ReactNode;
  metadata?: T;
};

export type CardItemProps = {
  id: string;
  title: string;
  description?: string | ReactNode;
  image?: SectionImageProps;
  actions?: SectionButtonProps[];
  tags?: string[];
};

export type DataArrayItem<T extends { id: string }> = T;

export interface SectionViewData<T extends Record<string, unknown> = Record<string, unknown>> {
  [key: string]: T;
}

export type SectionCompositionProps<T extends Record<string, unknown> = Record<string, unknown>> = {
  sections: T[];
  variant?: 'default' | 'minimal' | 'featured';
};

// ============================================================================
// DASHBOARD PREVIEW TYPES
// ============================================================================

export type DashboardPreviewContentConfig = {
  overline: string;
  heading: string;
  description: string;
  compactDensityLabel: string;
  comfortableDensityLabel: string;
  navLabelPrefix: string;
  colorLabelPrefix: string;
  lastChangeCompactLabel: string;
  lastChangeComfortableLabel: string;
  lastChangeNavLayoutPrefix: string;
  lastChangeNavColorPrefix: string;
  lastChangeFallbackLabel: string;
};

export type DashboardPreviewVisualConfig = {
  darkBorderOpacity: number;
  lightBorderOpacity: number;
  darkCardBgOpacity: number;
  lightCardBgOpacity: number;
  darkNavBgOpacity: number;
  lightNavBgOpacity: number;
  darkIntegrateNavBgOpacity: number;
  lightIntegrateNavBgOpacity: number;
  darkCanvasBgOpacity: number;
  lightCanvasBgOpacity: number;
};

export type SectionPreviewConfig<
  TContent extends object = DashboardPreviewContentConfig,
  TVisual extends object = DashboardPreviewVisualConfig,
> = {
  content?: Partial<TContent>;
  visualConfig?: Partial<TVisual>;
};

export type HomeHeroRouteMap = {
  workHref: string;
  servicesHref: string;
};
