---
sidebar_position: 2
sidebar_label: 'Architecture'
---

# Architecture: The `sections-api` Pattern and Why This Package Exists

This document explains the design thinking behind `@alexrebula/giselle-sections-sdk` — what problem it solves, how the data layer pattern works, and why the extraction boundary sits where it does.

---

## Why This Is Open Source

Every React project I start from scratch goes through the same bootstrapping work: defining section types, writing the same utility helpers, setting up the same data layer pattern. This package is my attempt to stop doing that work twice.

But the longer-term goal is a **portfolio platform**: one SDK, N client sites. The vision is that a developer installs this package, wires up their own data provider (PostgreSQL+Apollo, Supabase, Sanity, flat JSON — anything), and their consuming app becomes a **pure renderer** with no hardcoded content and no data logic. New portfolio site = install the package, fill in content, ship.

This requires:
- `builders/` — generic section builders the consuming app's factories delegate to
- `providers/` — a typed interface any backend implements to become pluggable

The package is public because none of this logic is personal. The content (names, copy, images, pricing, timeline) always stays in the consuming app's private data layer, or in a private backend the consumer controls.

That is the real reason this is a published package rather than a private utility folder.

---

## The Problem with Inline Portfolio Data

Portfolio sites typically scatter content across JSX files: hardcoded strings in props, inline image paths, copy-pasted arrays of objects directly inside component render trees. This approach works until it doesn't:

- Content changes require navigating JSX to find the right string
- There is no separation between "what data looks like" and "how data is rendered"
- Adding a CMS later means rewriting components, not just swapping the data source
- Nothing about the architecture signals to a technical reviewer that the developer builds real systems

---

## The `sections-api` Pattern

Treat the portfolio like a product: a pure data layer of typed factory functions that return typed props, consumed by presentation components that know nothing about data sources.

```
sections-api/
  types.ts          ← type contracts (interfaces, not values)
  api.ts            ← view-level orchestration (calls factories, assembles view data)
  home/
    data.tsx        ← createHomeHeroData(), createExpertiseAreasData(), ...
  about/
    data.ts         ← createAboutHeroData(), ...
  services/
    data.tsx        ← createServicePackagesData(), ...
```

**The rule:** Components receive typed props and render. They never import from `data.ts` files directly, never reach into a data store, and never hardcode strings. All content flows in from the data layer.

```ts
// ✗ inline data in JSX
<Section title="What I Do" items={[{ id: '1', icon: 'solar:code-bold', title: 'React' }]} />

// ✓ data layer returns typed props; component is a pure consumer
const homeView = buildHomeView();
<Section {...homeView.expertise} />
```

### The migration path

When the time comes to add a CMS, a database, or an API:

1. Factory functions become `async` adapters
2. They fetch from the real source and return the same typed props they return today
3. **Components are untouched** — they still just receive typed props and render

The data layer is the seam. Change what's behind it without touching what's in front of it.

---

## Platform Roadmap

This package evolves in phases. Each phase is backward-compatible — code written for Phase 1 continues to work in later phases.

### Phase 1 — Now (static factories)
The consuming app's factory functions return hardcoded typed data. This is the correct interim. Components are already decoupled from content. Package provides `types`, `utils`, and `samples`.

```
[your-portfolio-app — private]
  sections-api/
    home/data.ts      ← static factory, returns typed HomeViewData
    services/data.ts  ← static factory, returns typed ServicesViewData
  app/               ← pure renderer
```

### Phase 2 — Async adapters (post-launch)
Factory functions become `async` and fetch from a real backend (PostgreSQL via Apollo/GraphQL). Return shapes are identical — zero component changes. Supabase handles authentication for the CMS admin area.

```
[PostgreSQL + Apollo — private backend]
  ← all personal content: copy, pricing, images, timeline
  ← only accessible to the authenticated owner

[your-portfolio-app — private consuming app]
  sections-api/
    home/data.ts  ← async Apollo adapter, same return type
```

### Phase 3 — SDK builders (package extraction)
Generic builder logic is extracted from consuming app factories into `giselle-sections-sdk/builders/`. A typed `providers/` interface is added. Any backend that implements the interface becomes pluggable with no SDK changes.

```ts
// consuming app factory becomes a thin orchestrator
import { buildServicesPricingSection } from '@alexrebula/giselle-sections-sdk/builders';

export const createServicesPricingData = async ({ contactHref }) =>
  buildServicesPricingSection({
    content: await myProvider.getServicesPricingContent(),
    params: { contactHref },
  });
```

### Phase 4 — CMS admin dashboard
An authenticated admin area provides a GUI to edit section content, manage images, and preview live — without code deploys.

### Phase 5 — Second client (platform validated)
A second portfolio site installs `@alexrebula/giselle-sections-sdk`, implements the provider interface against its own backend, and ships without writing any factory logic. The platform claim is proven.

---

## Provider Interface (planned)

The pattern is one shared context type with interchangeable providers: a single context typed with one value interface, and separate provider implementations that all fulfil that same interface. You swap the provider wrapping the app; nothing inside the app changes.

`giselle-sections-sdk` will apply this model to section data.

### Layer 1 — Provider interface (in the SDK)

The SDK defines the shape it needs. No implementation, no backend knowledge:

```ts
// giselle-sections-sdk/src/providers/index.ts

export interface HomeViewContent {
  hero: { name: string; role: string; avatarSrc: string };
  expertiseAreas: Array<{ id: string; title: string; description: string }>;
  // ...
}

export interface ServicesViewContent {
  plans: Array<{ license: string; price: number; commons: string[]; options: string[] }>;
  faqItems: Array<{ question: string; paragraphs: string[] }>;
  // ...
}

export interface SectionDataProvider {
  getHomeViewContent(): Promise<HomeViewContent>;
  getServicesViewContent(): Promise<ServicesViewContent>;
  // ...
}
```

### Layer 2 — Builders (in the SDK)

The SDK owns validation, sanitization, and construction. No hardcoded content:

```ts
// giselle-sections-sdk/src/builders/home.ts

export function buildHomeHeroData(
  content: HomeViewContent['hero'],
  params: { assetsDir: string; contactHref: string }
): HomeHeroSectionProps {
  return {
    name: content.name,
    role: content.role,
    avatar: {
      src: `${params.assetsDir}${content.avatarSrc}`,
      alt: content.name,
    },
    contactHref: sanitizeCtaHref(params.contactHref, '/contact-us'),
  };
}
```

### Layer 3 — Client factory (in the SDK)

The SDK wires provider → builders. The consuming app calls this once with its own provider:

```ts
// giselle-sections-sdk/src/client.ts

import type { SectionDataProvider } from './providers';
import { buildHomeHeroData } from './builders/home';
import { buildServicesViewData } from './builders/services';

export function createSectionsClient(provider: SectionDataProvider) {
  return {
    async getHomeViewData(params: { assetsDir: string; contactHref: string }) {
      const content = await provider.getHomeViewContent();
      return {
        hero: buildHomeHeroData(content.hero, params),
        // ...
      };
    },
    async getServicesViewData(params: ServicesViewParams) {
      const content = await provider.getServicesViewContent();
      return buildServicesViewData(content, params);
    },
  };
}
```

### The consuming app's private provider (never in the SDK)

The consuming app implements the `SectionDataProvider` interface against its own backend. The SDK never sees credentials, queries, or schema:

```ts
// your-portfolio-app/src/providers/apollo-provider.ts  ← PRIVATE

import type { SectionDataProvider, HomeViewContent } from '@alexrebula/giselle-sections-sdk';

export class ApolloSectionsProvider implements SectionDataProvider {
  constructor(private client: ApolloClient<unknown>) {}

  async getHomeViewContent(): Promise<HomeViewContent> {
    const { data } = await this.client.query({ query: GET_HOME_CONTENT });
    return data.homeContent; // your DB schema, your GraphQL query — SDK never sees it
  }
}
```

A Supabase implementation of the same interface would look identical in structure — just a different fetch mechanism:

```ts
// your-portfolio-app/src/providers/supabase-provider.ts  ← PRIVATE

export class SupabaseSectionsProvider implements SectionDataProvider {
  async getHomeViewContent(): Promise<HomeViewContent> {
    const { data } = await supabase.from('home_content').select('*').single();
    return data;
  }
}
```

### Wiring it up in the consuming app

```ts
// your-portfolio-app/src/sections-api/client.ts

import { createSectionsClient } from '@alexrebula/giselle-sections-sdk';
import { ApolloSectionsProvider } from '../providers/apollo-provider';

const client = createSectionsClient(new ApolloSectionsProvider(apolloClient));

export const getHomeViewData = (params) => client.getHomeViewData(params);
export const getServicesViewData = (params) => client.getServicesViewData(params);
```

Swap `ApolloSectionsProvider` for `SupabaseSectionsProvider` and the rest of the app is untouched, because both providers fill the same shared context type.

The consuming app's backend credentials and content schema stay entirely private. The SDK never sees them.

---

## What Was Extracted into This Package

The `sections-api` lives inside the consuming app. But three things inside it have no app-specific content and are genuinely reusable:

| What             | Why it belongs in the package                                                      |
| ---------------- | ---------------------------------------------------------------------------------- |
| `types/index.ts` | Pure TypeScript interfaces — shapes, not values. No personal data.                |
| `utils/index.ts` | `createDataFactory`, `mapDataArray`, `filterDataArray` — pure functions, no state |
| `samples/index.ts` | Generic placeholder data for tests and Storybook                                |

Everything else stays in the consuming app:

| What stays in the app        | Why                                                                 |
| ---------------------------- | ------------------------------------------------------------------- |
| `home/data.tsx`              | Contains real names, testimonials, image paths, career history      |
| `about/data.ts`              | Personal bio, client logos, employment timeline                     |
| `services/data.tsx`          | Pricing, deliverables, process steps with personal content          |
| `api.ts`                     | Orchestrates the app's specific view structure                      |
| MUI-extended types (`sx:`)   | MUI is an app-level concern, not part of the generic type contracts |

### The extraction boundary test

> _"If someone else dropped this package into their project, would any of my personal content appear?"_

- **Types:** No. They are shapes.
- **Utils:** No. They are pure functions.
- **Samples:** No. They use "Sample Client", "Feature Title", placeholder hrefs.
- **Domain data factories:** Yes — names, testimonials, client logos, image paths. These stay in the app.

---

## React-First Design Decision

The types use `ReactNode` for rich content fields (`description`, `content`, `answer`, etc.). React is declared as a peer dependency (`^18.0.0 || ^19.0.0`).

This is a deliberate choice, not an oversight. The package is designed to be used in React/Next.js projects. Making it "framework-agnostic" would mean swapping `ReactNode` for `string | unknown` and losing the ability to pass rich content — which is a real use case for section descriptions and FAQ answers.

There is no JSX in the package. The types are compatible with React props but contain no rendering logic.

---

## Keeping MUI Out of the Package

The consuming app uses MUI v7. Many app-level types extend the package types with `sx: SxProps<Theme>` for styling. This extension lives in the app's own `types.ts`, not in this package.

Keeping MUI out of the package means:

- The package has no dependency on `@mui/material`
- Any React project can use the package, regardless of which component library it uses
- The styling layer is always an app-level concern

---

## Package Build

Built with [`tsup`](https://tsup.egoist.dev/) — zero-config bundler that handles ESM + CJS + TypeScript declarations in one command.

```ts
// tsup.config.ts
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  external: ['react'],
  clean: true,
});
```

`react` is marked external — it is not bundled into the output. The consuming app provides it via the peer dependency.

The `exports` field in `package.json` handles both ESM (`import`) and CJS (`require`) consumers:

```json
"exports": {
  ".": {
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js",
    "require": "./dist/index.cjs"
  }
}
```

---

## Local Development (`file:` protocol)

During development, before the package is published to npm, the consuming app references it locally:

```json
// consuming-app/package.json
"@alexrebula/giselle-sections-sdk": "file:../../../giselle-sections-sdk"
```

After any changes to the package, run `npm install` in the consuming app to re-link. `npm run build` in the package is not required for the type-check step (TypeScript resolves from `src/` via the local symlink), but is required for the published dist output.

---

## The TypeScript Duplicate-Export Catch

When the three Dashboard Preview types (`DashboardPreviewContentConfig`, `DashboardPreviewVisualConfig`, `SectionPreviewConfig`) were moved to the package, they weren't immediately removed from the app's `types.ts`. The app's `sections-api/index.ts` re-exports both `./api` (which imports from the package) and `./types` (which still had the same types defined locally). TypeScript caught it immediately:

```
TS2308: Module './api' has already exported a member named 'DashboardPreviewContentConfig'.
Consider explicitly re-exporting to resolve the ambiguity.
```

**Fix:** Remove the duplicate definitions from `types.ts`, import them from the package, and re-export them so nothing downstream needs to change its import paths:

```ts
// app/src/sections-api/types.ts
import type {
  DashboardPreviewContentConfig,
  DashboardPreviewVisualConfig,
  SectionPreviewConfig,
} from '@alexrebula/giselle-sections-sdk';

export type { DashboardPreviewContentConfig, DashboardPreviewVisualConfig, SectionPreviewConfig };
```

This is the canonical pattern for moving a type from an internal module to a package without breaking any consumers: import and re-export from the same location. Downstream code continues to `import from './types'` and sees nothing change.

This error is a good example of why a single source of truth for shared types matters. When the same type is defined in two places and both are re-exported through the same barrel, TypeScript gives you no choice but to fix it.
