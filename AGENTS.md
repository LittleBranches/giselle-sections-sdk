# Agent Brief

## ⚠️ PUBLIC REPOSITORY: read before writing anything

This repo is public. Anyone can read every commit, issue, PR, and comment.

**Rules, non-negotiable:**

- **Never reference private repository names, or file paths inside them**, in commits, PR descriptions, issue/PR bodies or comments, or committed docs — not even generically-worded ones that would let a reader infer a private repo's existence or structure. Describe anything sourced from a private context generically instead (e.g. "settled in an internal design session," "a private consuming app").
- `scripts/check-banned-content.js` (or `.mjs`) enforces a private-reference denylist against committed files (`docs/`, `src/`) as a backstop, loaded from `.banned-patterns.local` (gitignored, not committed — the actual denylist never lives in a committed file). It does not cover content posted live via `gh issue`/`gh pr`/`gh api` — that is caught by a separate mechanism outside this repo. Do not treat "the scanner passed" as proof a comment or issue body is clean; check it yourself before posting.
