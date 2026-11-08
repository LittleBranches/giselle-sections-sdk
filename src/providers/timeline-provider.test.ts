import { describe, expect, it } from 'vitest';

import type { TimelinePhaseDto } from '../career-timeline';
import {
  createStaticTimelineProvider,
  MAX_TIMELINE_PHASE_TITLE_LENGTH,
  parseTimelinePhaseTitle,
  TimelineValidationError,
} from './timeline-provider';
import type { TimelineDataProvider } from './timeline-provider';

const phase = (key: number): TimelinePhaseDto => ({
  key,
  title: `Phase ${key}`,
  side: 'left',
  iconId: 'solar:rocket-bold',
  tasks: [{ title: 'A task' }],
});

describe('createStaticTimelineProvider', () => {
  it('returns the phases it was given, asynchronously', async () => {
    const provider = createStaticTimelineProvider([phase(1), phase(2)]);
    const phases = provider.getTimelinePhases();
    expect(phases).toBeInstanceOf(Promise);
    expect((await phases).map((p) => p.key)).toEqual([1, 2]);
  });

  it('returns an empty list for no phases', async () => {
    expect(await createStaticTimelineProvider([]).getTimelinePhases()).toEqual([]);
  });

  it('hands back a copy, so a caller cannot change what the provider holds', async () => {
    const provider = createStaticTimelineProvider([phase(1)]);
    const first = await provider.getTimelinePhases();
    first.push(phase(9));
    expect((await provider.getTimelinePhases()).map((p) => p.key)).toEqual([1]);
  });

  it('is a TimelineDataProvider, the same shape any backend implements', async () => {
    const fromBackend: TimelineDataProvider = {
      getTimelinePhases: async () => [phase(3)],
    };
    const viaStatic: TimelineDataProvider = createStaticTimelineProvider([phase(3)]);
    expect(await fromBackend.getTimelinePhases()).toEqual(await viaStatic.getTimelinePhases());
  });
});

describe('parseTimelinePhaseTitle', () => {
  it('returns a valid title trimmed', () => {
    expect(parseTimelinePhaseTitle('  New title  ')).toBe('New title');
  });

  it.each([['an empty string', ''], ['only spaces', '   '], ['a number', 5], ['null', null], ['undefined', undefined]])(
    'rejects %s',
    (_label, value) => {
      expect(() => parseTimelinePhaseTitle(value)).toThrow(TimelineValidationError);
    }
  );

  it('accepts the longest allowed title and rejects one character more', () => {
    expect(parseTimelinePhaseTitle('a'.repeat(MAX_TIMELINE_PHASE_TITLE_LENGTH))).toHaveLength(
      MAX_TIMELINE_PHASE_TITLE_LENGTH
    );
    expect(() => parseTimelinePhaseTitle('a'.repeat(MAX_TIMELINE_PHASE_TITLE_LENGTH + 1))).toThrow(
      TimelineValidationError
    );
  });
});
