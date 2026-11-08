import { describe, expect, it } from 'vitest';
import {
  createPlatformIconItem,
  createPlatformLogoItem,
  createStableMilestoneKey,
  createStableTaskKey,
  mapTimelinePhaseDto,
  resolveDotBackground,
} from './utils';
import type { TimelinePhaseDto } from './types';

describe('createStableMilestoneKey', () => {
  it('builds a key from phase key, date, and title', () => {
    expect(
      createStableMilestoneKey(1, { title: 'Joined the team', date: '2020-01' })
    ).toBe('1-ms-2020-01-joined-the-team');
  });

  it('prefers shortTitle over title when present', () => {
    expect(
      createStableMilestoneKey(2, {
        title: 'A much longer descriptive title',
        shortTitle: 'Short',
        date: '2021-03',
      })
    ).toBe('2-ms-2021-03-short');
  });

  it('slugifies special characters to hyphens', () => {
    expect(
      createStableMilestoneKey(3, { title: "Launched v2.0! (Beta)", date: '2022/05' })
    ).toBe('3-ms-2022-05-launched-v2-0-beta');
  });

  it('collapses multiple consecutive separators and trims leading/trailing hyphens', () => {
    expect(
      createStableMilestoneKey(4, { title: '  ---Weird---Title---  ', date: '--2023--' })
    ).toBe('4-ms-2023-weird-title');
  });
});

describe('resolveDotBackground', () => {
  it('resolves light to white', () => {
    expect(resolveDotBackground('light')).toBe('#fff');
  });

  it('resolves dark to near-black', () => {
    expect(resolveDotBackground('dark')).toBe('#111');
  });

  it('resolves undefined to undefined', () => {
    expect(resolveDotBackground(undefined)).toBeUndefined();
  });
});

describe('createPlatformIconItem', () => {
  it('builds an icon platform DTO', () => {
    expect(createPlatformIconItem('logos:react', 'React')).toEqual({
      kind: 'icon',
      iconId: 'logos:react',
      label: 'React',
    });
  });
});

describe('createPlatformLogoItem', () => {
  it('builds a logo platform DTO', () => {
    expect(createPlatformLogoItem('/logos/acme.svg', 'Acme')).toEqual({
      kind: 'logo',
      src: '/logos/acme.svg',
      label: 'Acme',
    });
  });
});

describe('mapTimelinePhaseDto', () => {
  const renderIcon = (iconId: string) => `icon:${iconId}`;

  it('maps a full phase with milestones, platforms, and a footer', () => {
    const phaseDto: TimelinePhaseDto = {
      key: 7,
      title: 'Senior role',
      side: 'left',
      iconId: 'briefcase',
      footerSlot: 'audio-button',
      platforms: [createPlatformIconItem('logos:react', 'React'), 'Plain label'],
      milestones: [
        {
          date: '2019-06',
          title: 'Promoted',
          iconId: 'star',
          dotBgTone: 'dark',
        },
      ],
    };

    const mapped = mapTimelinePhaseDto(phaseDto, {
      renderIcon,
      renderPlatform: (platform) =>
        typeof platform === 'string' ? platform : `platform:${JSON.stringify(platform)}`,
      resolveFooter: (footerSlot) => (footerSlot ? `footer:${footerSlot}` : undefined),
    });

    expect(mapped.icon).toBe('icon:briefcase');
    expect(mapped.footer).toBe('footer:audio-button');
    expect(mapped.platforms).toEqual([
      'platform:{"kind":"icon","iconId":"logos:react","label":"React"}',
      'Plain label',
    ]);
    expect(mapped.milestones).toHaveLength(1);
    expect(mapped.milestones?.[0]).toEqual({
      date: '2019-06',
      title: 'Promoted',
      key: '7-ms-2019-06-promoted',
      icon: 'icon:star',
      dotBg: '#111',
    });
    // Other fields pass through untouched.
    expect(mapped.title).toBe('Senior role');
    expect(mapped.side).toBe('left');
  });

  it('maps a minimal phase with no platforms, milestones, or footer', () => {
    const phaseDto: TimelinePhaseDto = {
      key: 1,
      title: 'Started out',
      side: 'right',
      iconId: 'seedling',
    };

    const mapped = mapTimelinePhaseDto(phaseDto, {
      renderIcon,
      renderPlatform: (platform) => platform,
    });

    expect(mapped.icon).toBe('icon:seedling');
    expect(mapped.footer).toBeUndefined();
    expect(mapped.platforms).toBeUndefined();
    expect(mapped.milestones).toBeUndefined();
    expect(mapped.title).toBe('Started out');
  });

  it('passes through every field the real TimelinePhase/TimelineMilestone types support beyond the original hand-picked subset — regression coverage for the completeness fix', () => {
    const phaseDto: TimelinePhaseDto = {
      key: 3,
      title: 'Scenario phase',
      shortTitle: 'Scenario',
      side: 'left',
      iconId: 'flag',
      platformsLabel: 'Tech Stack',
      activeLabel: 'Now',
      photo: { src: '/photo.jpg', alt: 'A photo' },
      projects: [{ name: 'Side Project', logo: '/logos/side-project.svg' }],
      projectsLabel: 'Building in public',
      scenarioLabel: 'Option A',
      overdue: true,
      new: true,
      hideDecoration: true,
      textAlign: 'right',
      dotTooltip: 'Custom tooltip',
      milestones: [
        {
          date: '2020-01',
          title: 'A milestone',
          iconId: 'star',
          done: true,
          overdue: true,
          new: true,
          dotTooltip: 'Milestone tooltip',
        },
      ],
    };

    const mapped = mapTimelinePhaseDto(phaseDto, {
      renderIcon,
      renderPlatform: (platform) => platform,
    });

    expect(mapped.shortTitle).toBe('Scenario');
    expect(mapped.platformsLabel).toBe('Tech Stack');
    expect(mapped.activeLabel).toBe('Now');
    expect(mapped.photo).toEqual({ src: '/photo.jpg', alt: 'A photo' });
    expect(mapped.projects).toEqual([{ name: 'Side Project', logo: '/logos/side-project.svg' }]);
    expect(mapped.projectsLabel).toBe('Building in public');
    expect(mapped.scenarioLabel).toBe('Option A');
    expect(mapped.overdue).toBe(true);
    expect(mapped.new).toBe(true);
    expect(mapped.hideDecoration).toBe(true);
    expect(mapped.textAlign).toBe('right');
    expect(mapped.dotTooltip).toBe('Custom tooltip');

    const milestone = mapped.milestones?.[0];
    expect(milestone?.done).toBe(true);
    expect(milestone?.overdue).toBe(true);
    expect(milestone?.new).toBe(true);
    expect(milestone?.dotTooltip).toBe('Milestone tooltip');
  });
});

describe('createStableTaskKey', () => {
  it('builds a key from the task id alone', () => {
    expect(createStableTaskKey(41)).toBe('41');
    expect(createStableTaskKey('task-a')).toBe('task-a');
  });
});

describe('mapTimelinePhaseDto checklist tasks', () => {
  const renderers = {
    renderIcon: (iconId: string) => `icon:${iconId}`,
    renderPlatform: () => 'platform',
  };
  const dto: TimelinePhaseDto = {
    key: 7,
    title: 'A phase',
    side: 'left',
    iconId: 'solar:rocket-bold',
    tasks: [
      { id: 11, title: 'First task' },
      { id: 4, title: 'Second task', description: 'More', done: true },
    ],
  };

  it('resolves tasks into children keyed by their ids, and leaves no tasks behind', () => {
    const mapped = mapTimelinePhaseDto(dto, renderers);
    expect(mapped.children).toEqual([
      { id: 11, key: '11', title: 'First task' },
      { id: 4, key: '4', title: 'Second task', description: 'More', done: true },
    ]);
    expect('tasks' in mapped).toBe(false);
  });

  it('keeps a task key the same when tasks are reordered or one is removed', () => {
    const reordered = mapTimelinePhaseDto({ ...dto, tasks: [...dto.tasks!].reverse() }, renderers);
    expect(reordered.children?.map((child) => child.key)).toEqual(['4', '11']);
    const removed = mapTimelinePhaseDto({ ...dto, tasks: dto.tasks!.slice(1) }, renderers);
    expect(removed.children?.map((child) => child.key)).toEqual(['4']);
  });

  it('gives no children to a phase without tasks', () => {
    const { tasks: _tasks, ...bare } = dto;
    expect(mapTimelinePhaseDto(bare, renderers).children).toBeUndefined();
  });
});

describe('no Draft names', () => {
  it('exports no Draft-named function', async () => {
    const exported = await import('./index');
    expect(Object.keys(exported).filter((name) => /draft/i.test(name))).toEqual([]);
  });
});

describe('mapTimelinePhaseDto anchors', () => {
  const renderers = {
    renderIcon: (iconId: string) => `icon:${iconId}`,
    renderPlatform: () => 'platform',
  };

  it('passes a phase anchor and each milestone anchor through, so a provider can name them', () => {
    const dto: TimelinePhaseDto = {
      key: 1,
      title: 'A phase',
      side: 'left',
      iconId: 'x',
      anchor: 'career-a-phase',
      milestones: [
        { date: '2020', title: 'First', iconId: 'x', anchor: 'career-first' },
        { date: '2021', title: 'Second', iconId: 'x' },
      ],
    };
    const mapped = mapTimelinePhaseDto(dto, renderers);
    expect(mapped.anchor).toBe('career-a-phase');
    expect(mapped.milestones?.map((milestone) => milestone.anchor)).toEqual(['career-first', undefined]);
  });
});
