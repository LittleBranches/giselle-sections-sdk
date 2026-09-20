# @alexrebula/giselle-sections-sdk — Roadmap

Framework-agnostic, typed data SDK for React portfolio and product sites. No JSX. No MUI. Just types, builders, utilities, and samples.

See [`implementation-plan.md`](./implementation-plan.md) for the full task-level checklist.

Status legend: ✅ Done · 🔄 In progress · ⬜ Planned · ⏸ Blocked

---

## Current state — May 2026

Phase 0 (infrastructure) is mostly complete. Phase 1 (types, utils, samples) is active.

---

## Phase 0 — Package Skeleton 🔄 (mostly done)

| Item                                                        | Status |
| ----------------------------------------------------------- | ------ |
| Package scaffolded: `package.json`, `tsconfig.json`, `tsup.config.ts` | ✅ |
| Dual ESM + CJS output via tsup                              | ✅     |
| `peerDependencies` for `react ^18.0.0 \|\| ^19.0.0`        | ✅     |
| MIT `LICENSE`, `README.md`, `ARCHITECTURE.md`               | ✅     |
| PR template                                                 | ✅     |
| `vitest.config.ts` explicit setup + smoke test              | ⬜     |
| GitHub Actions CI (`typecheck` + `test` on push/PR)         | ⬜     |
| `.npmignore` (exclude `src/`, `__tests__/`, config files)   | ⬜     |

---

## Phase 1 — Types, Utils, Samples — SDK Core 🔄

| Item                                                        | Status |
| ----------------------------------------------------------- | ------ |
| `BaseSectionProps`, `SectionImageProps`, `HomeItemProps`    | ✅     |
| `createDataFactory` builder                                 | ✅     |
| Additional `BaseSectionProps` variants                      | ⬜     |
| Generic builder utilities (`mapDataArray`, `pickFields`)    | ⬜     |
| Generic sample/placeholder data for all section types       | ⬜     |

---

## Phase 2 — Async Provider Interface ⬜

| Item                                                        | Status |
| ----------------------------------------------------------- | ------ |
| Async data provider interface definition                    | ⬜     |
| Apollo adapter pattern                                      | ⬜     |
| Migration guide: sync factory → async provider              | ⬜     |
