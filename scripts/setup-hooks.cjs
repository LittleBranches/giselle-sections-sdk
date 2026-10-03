/**
 * Wires .githooks/ as the git hooks directory when contributors run `npm install`
 * (it is part of the `prepare` script).
 *
 * Skips silently in CI environments and outside git working trees. Always exits 0,
 * even when `git config` fails (a warning is printed instead): it must never break
 * an install.
 */
const { execFileSync } = require('child_process');
const { existsSync } = require('fs');
const path = require('path');

// Skip in CI — hooks are never executed in CI environments
if (process.env.CI) {
  process.exit(0);
}

const repoRoot = path.resolve(__dirname, '..');
const gitDir = path.join(repoRoot, '.git');
const hooksDir = path.join(repoRoot, '.githooks');

// Skip if not inside a git working tree (e.g. installed as a dependency or tarball)
if (!existsSync(gitDir)) {
  process.exit(0);
}

if (existsSync(hooksDir)) {
  try {
    // cwd is the repo root, so this never rewrites another repository's hooks path
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
    console.log('✓ Git hooks configured: .githooks/');
  } catch (err) {
    console.warn('Warning: could not configure git hooks —', err.message);
  }
} else {
  console.warn('Warning: .githooks/ directory not found — hooks not wired.');
}
