# @alexrebula/giselle-sections-sdk

**A provider-agnostic, typed sections data SDK for React portfolio and product sites.**

This package is the reusable public core of the `sections-api` pattern — a data layer architecture that separates typed section contracts from personal content and backend implementation. The long-term goal is a **headless CMS SDK**: install this package, wire up your own data provider (PostgreSQL+Apollo, Supabase, Sanity, flat JSON — anything), and your consuming app becomes a pure renderer with no hardcoded content.

No JSX. No MUI. No personal content. Just types, builders, utilities, and samples.

> **License independence (MIT):** This package has no UI framework dependency — it is a pure data layer (types, utilities, and samples) designed to work with any React stack. This is an architectural decision: keeping the SDK framework-agnostic means consumers can use MUI, Tailwind, or anything else without coupling. No code has been copied or derived from any proprietary theme or kit. See [LICENSE](./LICENSE).

See [docs/architecture.md](./docs/architecture.md) for the full design rationale, platform vision, and phase roadmap.

---

## The mango tree

The Giselle packages are a Philippine mango tree. The trunk is the shared foundation — TypeScript conventions, typed data contracts, test discipline — that all packages grow from. Each package is one mango on the tree, at its own stage of ripeness.

`giselle-sections-sdk` is the **green mango** 🟢 — functional, typed, and already in use, but the API is still evolving fast. It is the deepest root on the tree: a framework-agnostic data layer that lets any consuming app stay a pure renderer with zero hardcoded content. When the builders and providers phases ship, this mango starts turning yellow-green.

Ripeness scale: 🟢 alpha → 🟡 beta → 🟠 stable → 🟤 LTS.

---

## Status

**Phase 1 — `v0.1.0` (active development)**

Currently shipping `types`, `utils`, and `samples`. The reference portfolio implementation uses static factory functions today — this is the correct interim before a real backend is wired up.

**Planned for later phases:**
- `builders/` — generic section builder functions, no hardcoded strings; consuming app factories call builders and pass their own content
- `providers/` — typed provider interface; any backend (Apollo/GraphQL, Supabase, Sanity, flat JSON) implements it and becomes pluggable

First public npm release planned after the portfolio ships. See [docs/architecture.md](./docs/architecture.md) for the full phase roadmap.

**The test suite will receive a full review and overhaul before the first npm publish.**
No package ships to npm until the tests meet the same standard as the implementation.

---

## What's in the box

| Module        | Status    | Contents                                                                                                          |
| ------------- | --------- | ----------------------------------------------------------------------------------------------------------------- |
| `types`       | ✅ Now    | All shared TypeScript interfaces — `BaseSectionProps`, `HomeItemProps`, `TestimonialItemProps`, `FAQItemProps`, `ServicePackageProps`, `DashboardPreviewContentConfig`, and more |
| `utils`       | ✅ Now    | Pure, stateless helpers — `createDataFactory`, `mapDataArray`, `filterDataArray`, `createFaqToolButtons`         |
| `samples`     | ✅ Now    | Generic placeholder data for tests and Storybook — `HOME_ITEMS_SAMPLE`, `HOME_TESTIMONIALS_SAMPLE`, `HOME_FAQS_SAMPLE`, and more |
| `career-timeline` | ✅ Now (tested) | Provider/UI-agnostic types and adapter logic for a two-column career timeline — `TimelinePhaseDraft`, `TimelineMilestoneDraft`, `mapTimelinePhaseDraft`, `createStableMilestoneKey`, `resolveDotBackground`, and more. This slice has a real, reviewed test suite already — see the note below on the rest of the package. |
| `builders`    | 🔜 Planned | Generic section builder functions — take typed content + params, return typed section props; no hardcoded strings |
| `providers`   | 🔜 Planned | Typed provider interface — any backend (Apollo, Supabase, Sanity, JSON) can implement it and become pluggable    |

Everything is exported from the root:

```ts
import type { HomeItemProps, FAQItemProps, ServicePackageProps } from '@alexrebula/giselle-sections-sdk';
import { createDataFactory, mapDataArray, HOME_ITEMS_SAMPLE } from '@alexrebula/giselle-sections-sdk';
```

---

## Installation (not yet available, but planned upon portfolio publish)

```bash
npm install @alexrebula/giselle-sections-sdk
```

**Peer dependency:** React `^18.0.0 || ^19.0.0` is required. The types use `ReactNode` for rich content fields.

---

## Usage

The examples below show how to use this package **in your consuming app's data layer** — typically inside your own `sections-api/`, `sections-data/` or equivalent directory. The hardcoded values in factory functions are your real content; the package only provides the type contracts.

### Typing your data factories

In your app, write a factory function that returns typed props. The types come from this package; the content is yours:

```ts
// your-app/src/sections-api/home/data.ts
import type { HomeItemProps } from '@alexrebula/giselle-sections-sdk';

export const createFeatureItems = (): HomeItemProps[] => [
  {
    id: 'react',
    icon: 'logos:react',
    title: 'React & Next.js',
    description: 'Your real description here.',
  },
];
```

### Building a typed section factory

```ts
// your-app/src/sections-api/home/data.ts
import type { BaseSectionProps, FAQItemProps } from '@alexrebula/giselle-sections-sdk';

type FaqSectionData = BaseSectionProps & { faqs: FAQItemProps[] };

export const createFaqSectionData = (): FaqSectionData => ({
  title: 'Your Section Title',
  faqs: [
    { question: 'Your question', answer: 'Your answer.' },
  ],
});
```

### Using utilities

```ts
import { createDataFactory, mapDataArray } from '@alexrebula/giselle-sections-sdk';
import type { HomeItemProps } from '@alexrebula/giselle-sections-sdk';

const base: HomeItemProps = { id: 'base', icon: 'solar:star-bold', title: 'Base Item' };
const item = createDataFactory(base, { title: 'Custom Title' });

const labels = mapDataArray(items, (item) => item.title);
```

### Using samples in tests

```ts
import { HOME_ITEMS_SAMPLE, HOME_TESTIMONIALS_SAMPLE } from '@alexrebula/giselle-sections-sdk';

it('renders all items', () => {
  render(<MySection items={HOME_ITEMS_SAMPLE} />);
  expect(screen.getAllByRole('article')).toHaveLength(HOME_ITEMS_SAMPLE.length);
});
```

---

## Contributing / working on this package locally

If you are developing this package alongside a consuming app (before publishing to npm), reference it from disk using the `file:` protocol:

```json
// your-app/package.json
"@alexrebula/giselle-sections-sdk": "file:../path/to/giselle-sections-sdk"
```

Run `npm install` in the consuming app once to create the symlink in `node_modules/`. After that, TypeScript changes in `src/` are picked up immediately — no rebuild needed. Re-run `npm install` only if you change this package's `package.json` (e.g. add a new export entry).

---

## Build

```bash
npm run build       # tsup → dist/index.js (ESM) + dist/index.cjs (CJS) + dist/index.d.ts
npm run typecheck   # tsc --noEmit
npm run test        # vitest run
```

---

## Design decisions

- **React-first.** Types use `ReactNode` for rich content fields. React is declared as a peer dependency. No JSX in the package — just types compatible with React props.
- **No MUI.** The consuming app extends these types with `sx: SxProps<Theme>` where needed. MUI stays an app-level concern.
- **No personal content.** Domain data factories contain real personal content and live in the consuming app only.
- **Single extraction boundary.** Types are shapes; utils are pure functions; samples use placeholder text.
- **Provider-agnostic by design.** When `providers/` lands, any backend that implements the typed provider interface becomes a drop-in data source — no SDK changes required.

See [docs/architecture.md](./docs/architecture.md) for the full rationale and platform roadmap.

### License
MIT
