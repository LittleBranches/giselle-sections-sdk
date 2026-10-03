# Agent Brief

## ⚠️ PUBLIC REPOSITORY: read before writing anything

This repo is public. Anyone can read every commit, issue, PR, and comment.

**Rules, non-negotiable:**

- **Never reference private repository names, or file paths inside them**, in commits, PR descriptions, issue/PR bodies or comments, or committed docs — not even generically-worded ones that would let a reader infer a private repo's existence or structure. Describe anything sourced from a private context generically instead (e.g. "settled in an internal design session," "a private consuming app").
- `scripts/check-banned-content.js` scans committed files (`docs/`, `src/`, `.github/`, `README.md`, `AGENTS.md`) for the names listed in `.banned-patterns.local` as a backstop. That file is gitignored and never committed (the actual denylist never lives in a committed file): create it yourself, one name or path per line. Without it the script scans nothing and says so. It reads the working tree, not the commits being pushed or their messages, and it does not cover content posted live via `gh issue`/`gh pr`/`gh api` — that is caught by a separate mechanism outside this repo. Do not treat "the scanner passed" as proof a comment or issue body is clean; check it yourself before posting.
