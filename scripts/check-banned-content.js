#!/usr/bin/env node
/**
 * check-banned-content.js
 *
 * Scans this repository's docs, source, GitHub config and top-level markdown for
 * private repo names or paths that must not appear in this public repository.
 * Nothing else catches a private repo name or path in a *.md file; this script
 * fills that gap.
 *
 * IMPORTANT — never hardcode an actual private repo name or path in this
 * file. This file is committed and public; anyone can read it. The actual
 * denylist lives in `.banned-patterns.local` (gitignored, not committed) and is
 * loaded at runtime below. This file only defines the *mechanism*. Create that
 * file yourself: one name or path per line, `#` comments allowed. Matching is
 * case-insensitive.
 *
 * If `.banned-patterns.local` doesn't exist, nothing is scanned: the script says
 * so on stderr and still exits 0. It is a personal safety net, not a
 * CI-enforced list (GitHub Actions has no access to a gitignored file).
 *
 * Run by `.githooks/pre-push` (through `npm run banned-content`). It reads the
 * working tree, not the commits being pushed or their messages.
 *
 * Exit codes: 0 = clean, or nothing to scan; 1 = violations found.
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

/** Lower-cased once, so each line is compared case-insensitively. */
const NEEDLES = loadLocalPatterns().map((pattern) => pattern.toLowerCase());

// ── File targets ───────────────────────────────────────────────────────────

/** Folders scanned recursively. */
const SCAN_DIRS = ['docs', 'src', '.github'];

/** Single files scanned at the repo root. */
const SCAN_FILES = ['README.md', 'AGENTS.md'];

/** Only scan files with these extensions. */
const SCAN_EXTENSIONS = new Set(['.md', '.mdx', '.ts', '.tsx', '.js', '.mjs', '.yml', '.yaml']);

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

/** Every file to scan that exists, as absolute paths. */
function* scanTargets() {
  for (const scanDir of SCAN_DIRS) {
    const dirPath = path.join(ROOT, scanDir);
    if (existsSync(dirPath) && statSync(dirPath).isDirectory()) yield* walkDir(dirPath);
  }
  for (const file of SCAN_FILES) {
    const filePath = path.join(ROOT, file);
    if (existsSync(filePath) && statSync(filePath).isFile()) yield filePath;
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

if (NEEDLES.length === 0) {
  console.warn(
    '⚠  Banned content scan: no patterns loaded (.banned-patterns.local not found) — nothing was scanned'
  );
  process.exit(0);
}

const violations = [];
let scannedFiles = 0;

for (const filePath of scanTargets()) {
  scannedFiles += 1;
  const rel = path.relative(ROOT, filePath).replace(/\\/g, '/');
  const lines = readFileSync(filePath, 'utf-8').split('\n');

  lines.forEach((line, index) => {
    const lower = line.toLowerCase();
    if (NEEDLES.some((needle) => lower.includes(needle))) {
      violations.push({ file: rel, line: index + 1, text: line.trim() });
    }
  });
}

if (violations.length === 0) {
  console.log(
    `✓ Banned content scan passed — ${scannedFiles} files, ${NEEDLES.length} patterns, no violations found`
  );
  process.exit(0);
}

console.error(`\n❌  Banned content scan — ${violations.length} violation(s) found:\n`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  [private-ref]`);
  console.error(`    ${v.text}\n`);
}
console.error('Fix: remove or replace the flagged text before pushing.');
process.exit(1);
