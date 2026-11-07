import { describe, expect, it } from 'vitest';

import pkg from '../package.json';

type PackageJson = {
  name: string;
  files: string[];
  scripts: Record<string, string>;
  publishConfig?: { registry?: string; access?: string };
};

const meta = pkg as PackageJson;

describe('package metadata for publishing', () => {
  it('is published as @littlebranches/giselle-sections-sdk', () => {
    expect(meta.name).toBe('@littlebranches/giselle-sections-sdk');
  });

  it('publishes to GitHub Packages', () => {
    expect(meta.publishConfig?.registry).toBe('https://npm.pkg.github.com');
    expect(meta.publishConfig?.access).toBe('public');
  });

  it('builds before packing, so a release never ships a stale dist', () => {
    expect(meta.scripts['prepack']).toContain('npm run build');
  });

  it('ships only the build, the readme and the licence', () => {
    expect(meta.files).toEqual(['dist', 'README.md', 'LICENSE']);
  });
});
