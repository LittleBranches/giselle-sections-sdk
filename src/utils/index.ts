/**
 * @file utils/index.ts
 * @description Shared data utilities for building section data factories.
 * @usage import { createDataFactory, mapDataArray, filterDataArray, createFaqToolButtons, fillSlots } from '@littlebranches/giselle-sections-sdk'
 */

import type { FaqToolLink } from '../types';

export { fillSlots } from './fill-slots';

export const createFaqToolButtons = (tools: FaqToolLink[]): FaqToolLink[] => tools;

export const createDataFactory = <T extends { id: string }>(
  template: T,
  overrides?: Partial<T>
): T => ({
  ...template,
  ...overrides,
});

export const mapDataArray = <T, U>(items: T[], mapper: (item: T, index: number) => U): U[] =>
  items.reduce<U[]>((acc, item, index) => {
    acc.push(mapper(item, index));
    return acc;
  }, []);

export const filterDataArray = <T>(items: T[], predicate: (item: T) => boolean): T[] =>
  items.filter(predicate);
