#!/usr/bin/env node
/**
 * check-banned-content.js
 *
 * Scans docs/ and src/ for private repo references that must not appear in
 * this public repository. ESLint catches banned identifiers in *.ts/*.tsx
 * files, but nothing else catches a private repo name/path in *.md files —
 * this script fills that gap.
 *
 * IMPORTANT — never hardcode an actual private repo name or path in this
 * file. This file is committed and public; anyone can read it. The actual
 * denylist of private repo names/paths lives in `.banned-patterns.local`
 * (gitignored, not committed — same pattern as this org's other repos)
 * and is loaded at runtime below. This file only defines the *mechanism*.
 * If `.banned-patterns.local` doesn't exist, the scan still runs (checks
 * nothing extra) rather than failing — it's a personal safety net, not a
 * CI-enforced list (GitHub Actions has no access to a gitignored file).
 *
 * Exit codes: 0 = clean, 1 = violations found.
 *
 * Called by the quality gate as a "banned content scan" step, mirroring
 * the same script in this org's other public repos (giselle-mui, skills).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// ── Banned patterns ────────────────────────────────────────────────────────

/**
 * Load private repo names/paths from the gitignored local file, if present.
 * One pattern per line; blank lines and `#` comments are skipped. Never add
 * an actual private repo name/path to this script directly — see the
 * module-level comment.
 */
function loadLocalPatterns() {
  const localFile = path.join(ROOT, '.banned-patterns.local');
  if (!existsSync(localFile)) return [];
  return readFileSync(localFile, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

const BANNED_PRIVATE_REFS = loadLocalPatterns();

// ── File targets ───────────────────────────────────────────────────────────

const SCAN_DIRS = ['docs', 'src'];

/** Only scan files with these extensions. */
const SCAN_EXTENSIONS = new Set(['.md', '.mdx', '.ts', '.tsx', '.js', '.mjs']);

// ── Allowlist ──────────────────────────────────────────────────────────────

/**
 * Files that are explicitly permitted to contain a banned pattern because
 * their purpose IS to document or enforce the rule (e.g. this script
 * itself). Paths are relative to the repo root, using forward slashes.
 */
const ALLOWED_FILES = new Set(['scripts/check-banned-content.js']);

/** Walk a directory recursively, yielding absolute file paths. */
function* walkDir(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDir(fullPath);
    } else if (entry.isFile() && SCAN_EXTENSIONS.has(path.extname(entry.name))) {
      yield fullPath;
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

const violations = [];

if (BANNED_PRIVATE_REFS.length > 0) {
  for (const scanDir of SCAN_DIRS) {
    const dirPath = path.join(ROOT, scanDir);
    let dirStat;
    try {
      dirStat = statSync(dirPath);
    } catch {
      continue; // directory doesn't exist — skip
    }
    if (!dirStat.isDirectory()) continue;

    for (const filePath of walkDir(dirPath)) {
      const rel = path.relative(ROOT, filePath).replace(/\\/g, '/');

      if (ALLOWED_FILES.has(rel)) continue;

      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i + 1;

        for (const ref of BANNED_PRIVATE_REFS) {
          if (!line.includes(ref)) continue;

          violations.push({
            file: rel,
            line: lineNum,
            text: line.trim(),
            rule: 'private-ref',
          });
        }
      }
    }
  }
}

if (violations.length === 0) {
  console.log('✓ Banned content scan passed — no violations found');
  process.exit(0);
} else {
  console.error(`\n❌  Banned content scan — ${violations.length} violation(s) found:\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.rule}]`);
    console.error(`    ${v.text}\n`);
  }
  console.error('Fix: remove or replace the flagged text before pushing.');
  process.exit(1);
}
