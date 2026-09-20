# @alexrebula/giselle-sections-sdk — Copilot Instructions

This is a **public, MIT-licensed** TypeScript SDK package.
It is the framework-agnostic data layer of the sections-api pattern.

## ⚠️ Copyright rule — read this first

This package is MIT-licensed and public. It must contain **zero code derived from any
proprietary theme or kit** — including the Minimals MUI kit used in the sibling
`alexrebula` portfolio project.

**Hard rules — non-negotiable:**

1. **No Minimals code.** The following identifiers must never appear in this package:
   `varAlpha`, `varFade`, `varBlur`, `customShadows`, `_mock`, or any other utility
   that originated in the Minimals theme. If similar functionality is needed, write it
   from scratch independently.

2. **No imports from the `alexrebula` portfolio.** This package must not import from
   `alexrebula/src/` or any path inside that private repo.

3. **No proprietary dependencies.** Only pure TypeScript and `react` types (for `ReactNode`)
   are permitted. No UI frameworks, no theme packages, no commercial libraries.

## What this package is

A provider-agnostic, typed data SDK for React portfolio and product sites.
No JSX. No MUI. No personal content. Just types, builders, utilities, and samples.

- `src/types/` — shared TypeScript interfaces (`BaseSectionProps`, `HomeItemProps`, etc.)
- `src/utils/` — pure, stateless helpers (`createDataFactory`, `mapDataArray`, etc.)
- `src/samples/` — generic placeholder data for tests and Storybook (safe to publish)

## Stack

- TypeScript 5.x (strict, no `any`)
- `react` (types only, for `ReactNode` — not a runtime dependency)
- tsup for building (ESM + CJS)
- No runtime UI framework dependency — consumers bring their own

## Cross-agent behavior guardrails (Karpathy baseline)

Apply these defaults on every task unless a stricter repo rule overrides them.

1. **Think before coding.** State assumptions. If multiple interpretations exist, present them and ask when uncertain.
2. **Simplicity first.** Implement the minimum solution that satisfies the request. Do not add speculative abstraction, configurability, or extra features.
3. **Surgical changes.** Touch only what is required for the request. Avoid unrelated refactors, formatting drift, or drive-by cleanup.
4. **Goal-driven execution.** Define verifiable success criteria and close the loop with checks (tests, lint, typecheck, or explicit validation).

## Brand identity — the Giselle mango tree

The Giselle ecosystem is named after the Filipino wife of the author. The Philippine national fruit is the Carabao mango — both the logo mark and the ecosystem metaphor.

- **The tree** = shared foundation: typed data contracts, TypeScript conventions, test discipline
- **Each branch** = a package (`giselle-mui`, `giselle-sections-sdk`, `giselle-ui`, `giselle-docs`)
- **Each mango** = a release at its own ripeness stage

Ripeness scale: 🟢 green = alpha · 🟡 yellow-green = beta · 🟠 golden = stable · 🟤 amber = LTS

`giselle-sections-sdk` is the **green mango** — deepest root, functional but evolving fast. Framework-agnostic data layer.

**WC-6:** The planned wide hero illustration — watercolour mango tree with per-package label badges. See `alexrebula/docs/brand/logo-concept.md` Track A.

## Session bootstrap: where Copilot should look first

At the start of every new Copilot session in this package, read these files:

| File                                                            | Purpose                                                                                             |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [`docs/architecture.md`](../docs/architecture.md)               | Design rationale: the sections-api pattern, why this is open-source, provider model, migration path |
| [`docs/implementation-plan.md`](../docs/implementation-plan.md) | Per-phase task checklist with `[x]` / `[ ]` status                                                  |

### Current status

- **Phase 0** (package skeleton): mostly done. Still open: `vitest.config.ts` explicit setup, smoke test, GitHub Actions CI, `.npmignore`.
- **Phase 1** (types, utils, samples): active. Core types and builders shipped. Open: additional `BaseSectionProps` variants, generic builder utilities, sample data.
- **Phase 2** (async provider interface): not started.

### What belongs in this package

- Shared TypeScript interfaces that any sections-api consumer would need (`BaseSectionProps`, `SectionItemBase`, etc.)
- Pure utility helpers (`createDataFactory`, `mapDataArray`, `pickFields`, etc.) — no side effects, no JSX
- Generic sample/placeholder data safe to publish (no personal content)
- **NOT** personal content (names, images, specific copy from `alexrebula`)
- **NOT** UI components, MUI wrappers, or any CSS

### What Copilot should help build

- New shared type interfaces following strict TypeScript conventions
- Pure utility functions with Vitest unit tests
- Generic sample data objects for each section type
- `IMPLEMENTATION_PLAN.md` updates when tasks are completed

---

## Contributor profiles — code review tone

This repository welcomes contributors at all experience levels. When reviewing any PR:

- **Hold the same quality standard regardless of contributor experience.** Do not lower the bar — explain what needs to change and why, just as you would for any contributor.
- **Explain the why, not just the what.** Do not say "use `const` here"; say "use `const` here because this value never changes — it signals to anyone reading the code that this was intentional, not a mistake."
- **One issue per comment.** Do not stack multiple changes into one comment.
- **Acknowledge what is correct before noting what to improve.**
- **When something is wrong, show what correct looks like** — not just "this is wrong"; show the fixed version and explain why it is better.
- **Four sentences max per comment.** Link to MDN or the repo README instead of writing a lecture inline.
- **No jargon without a definition.** If a term like "idempotent", "side effect", or "type assertion" appears in a comment, define it in the same sentence.
- **Do not ask for perfection.** If the code is correct, passes the quality gate, and solves the problem — it ships. Encourage, merge, move on.
