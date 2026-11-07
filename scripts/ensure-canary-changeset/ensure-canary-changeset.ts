#!/usr/bin/env node
/**
 * ensure-canary-changeset.ts
 *
 * `changeset version --snapshot <tag>` (see .github/workflows/canary-publish.yml)
 * requires at least one pending changeset in .changeset/ — with none present
 * it exits non-zero ("No unreleased changesets found"). A merge to `main`
 * that didn't add a changeset (docs-only, CI-only, dependency bumps, etc.)
 * would otherwise fail to produce a canary release.
 *
 * This script runs immediately before `changeset version --snapshot canary`
 * in CI: if .changeset/ holds no real changeset file (anything other than
 * its own README.md), it writes one throwaway `patch` changeset so the
 * snapshot always has something to version. The version step consumes
 * (deletes) whatever changeset files exist, real or synthetic, so this file
 * never survives past that step and is never committed — .changeset/config.json
 * sets "commit": false, and nothing in the canary-publish workflow runs
 * `git push`.
 *
 * Usage: node scripts/ensure-canary-changeset/ensure-canary-changeset.ts
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const CHANGESET_DIR = path.join(REPO_ROOT, '.changeset');
const SYNTHETIC_CHANGESET_PATH = path.join(CHANGESET_DIR, 'ci-canary-snapshot.md');

function getPackageName(): string {
  const pkgPath = path.join(REPO_ROOT, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
  if (!pkg.name) {
    throw new Error(`package.json at ${pkgPath} has no "name" field.`);
  }
  return pkg.name;
}

function hasRealChangeset(): boolean {
  if (!existsSync(CHANGESET_DIR)) {
    return false;
  }
  return readdirSync(CHANGESET_DIR).some((entry) => entry.endsWith('.md') && entry !== 'README.md');
}

function main(): void {
  if (hasRealChangeset()) {
    console.log('ensure-canary-changeset: a real changeset is already pending — nothing to do.');
    return;
  }

  const packageName = getPackageName();
  mkdirSync(CHANGESET_DIR, { recursive: true });
  writeFileSync(
    SYNTHETIC_CHANGESET_PATH,
    `---\n"${packageName}": patch\n---\n\nAutomated canary snapshot release (no changeset present at merge time).\n`
  );
  console.log(`ensure-canary-changeset: wrote a throwaway patch changeset for ${packageName}.`);
}

main();
