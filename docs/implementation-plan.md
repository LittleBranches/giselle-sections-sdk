---
sidebar_position: 3
sidebar_label: 'Implementation Plan'
---

# `@alexrebula/giselle-sections-sdk` — Implementation Plan

Full from-scratch-to-platform build checklist. Each phase is backward-compatible with the previous one. No phase requires tearing down what came before.

---

## Legend

- `[x]` Done
- `[ ]` Not started
- `[-]` In progress

---

## Phase 0 — Package Skeleton

Initial repo, build tooling, and quality gates.

- [x] Init repo with `package.json`, `tsconfig.json`, `tsup.config.ts`
- [x] Configure dual ESM + CJS output via tsup
- [x] Mark `react` as external in tsup config
- [x] Set `"type": "module"` + `exports` field with `types`, `import`, `require` keys
- [x] Add `peerDependencies` for `react ^18.0.0 || ^19.0.0`
- [x] Add `vitest` for unit testing
- [x] Add `npm run build`, `typecheck`, `test`, `test:watch` scripts
- [x] Add `.gitignore` (dist, node_modules)
- [x] Write `README.md` with install, usage, contributing sections
- [x] Write `ARCHITECTURE.md` with sections-api pattern, provider model, phase roadmap
- [x] Add MIT `LICENSE`
- [ ] Add `vitest.config.ts` explicitly (or verify vitest picks up config from `package.json`)
- [ ] Set up `__tests__/` convention and add a smoke test that the package imports cleanly
- [ ] Add GitHub Actions CI: `typecheck` + `test` on push/PR
- [ ] Add `.npmignore` (exclude `src/`, `__tests__/`, config files from published package)

---

## Phase 1 — Types, Utils, Samples ✅

Pure, no-runtime data contracts and helpers. Currently active.

### Types (`src/types/index.ts`)

- [x] `BaseSectionProps` — caption, title, txtGradient, description
- [x] `SectionImageProps` — alt, src, key
- [x] `SectionButtonProps` — label, href, variant, color
- [x] `SectionIconButtonProps` — extends button + icon
- [x] `SectionItemBase` — id, title, description
- [x] `SectionIconItem` — extends base + icon
- [x] `SectionFeaturedItem` — extends base + featured, subtitle
- [x] `SectionImageItem` — extends base + imgUrl
- [x] `HeroAvatarProps`, `HomeHeroProps`
- [x] `HomeItemProps`, `ExpertiseAreasProps`
- [x] `HomeIntegrationsProps`
- [x] `TestimonialItemProps`, `HomeTestimonialsProps`
- [x] `FAQItemProps`, `HomeFAQsProps`
- [x] `HighlightFeatureItemProps`, `HomeHighlightFeaturesSectionProps`
- [x] `HugePackImageProps`, `HugePackElementsSectionProps`
- [x] `AdvertisementSectionProps`, `ForDesignerSectionProps`
- [x] `PricingPlanProps`, `PricingSectionProps`
- [x] `ServicePackageProps`, `DesignAddOnProps`, `DeliveryStepProps`
- [x] `ServiceDeliverableProps`, `ServiceProcessItemProps`
- [x] `FaqToolLink`, `HomeFaqToolLink`, `ServicesFaqToolLink`
- [x] `HomeFaqSchemaItem`, `ServicesFaqSchemaItem`
- [x] `AboutHeroClientLogoProps`, `AboutHeroDataProps`, `AboutHeroProps`
- [x] `GridItemProps<T>`, `CardItemProps`, `DataArrayItem<T>`
- [x] `SectionViewData<T>`, `SectionCompositionProps<T>`
- [x] `DashboardPreviewContentConfig`, `DashboardPreviewVisualConfig`, `SectionPreviewConfig<TContent, TVisual>`
- [x] `HomeHeroRouteMap`
- [ ] Add `WorkSectionProps` type (portfolio case study items)
- [ ] Add `ContactSectionProps` type (form fields, social links, map config)
- [ ] Add `NavbarProps` / `FooterProps` types (reusable layout section shapes)
- [ ] Add `BlogSectionProps` (post card list, pagination shape)
- [ ] Audit: ensure every field that could be `ReactNode` vs `string` is explicit and documented
- [ ] Split large `types/index.ts` into domain files (`types/home.ts`, `types/services.ts`, `types/about.ts`, `types/common.ts`) with a barrel `types/index.ts`

### Utils (`src/utils/index.ts`)

- [x] `createFaqToolButtons()` — passthrough (enhancement point)
- [x] `createDataFactory<T>()` — shallow merge template + overrides
- [x] `mapDataArray<T, U>()` — transform with reducer
- [x] `filterDataArray<T>()` — predicate filter
- [ ] `sanitizeCtaHref(href, fallback)` — ensure href is non-empty, falls back safely (needed by Phase 3 builders)
- [ ] `buildAssetPath(assetsDir, filename)` — join path segments safely, no double slashes
- [ ] `createSectionId(slug)` — normalise a string into a stable kebab-case section id
- [ ] `sortDataArray<T>(items, key, direction)` — generic sort helper
- [ ] Unit tests for all utils (100% coverage target)

### Samples (`src/samples/index.ts`)

- [x] `FEATURE_ITEM_TEMPLATE: HomeItemProps`
- [x] `PRICING_PACKAGE_TEMPLATE: ServicePackageProps`
- [x] `SECTION_DATA_TEMPLATE`
- [x] `FAQ_TOOL_LINKS_SAMPLE: FaqToolLink[]`
- [x] `HOME_ITEMS_SAMPLE: HomeItemProps[]`
- [x] `HOME_TESTIMONIALS_SAMPLE: TestimonialItemProps[]`
- [x] `HOME_FAQS_SAMPLE: FAQItemProps[]`
- [ ] `ABOUT_HERO_SAMPLE: AboutHeroProps`
- [ ] `SERVICES_PACKAGES_SAMPLE: ServicePackageProps[]` (3 tier)
- [ ] `WORK_ITEMS_SAMPLE: WorkSectionProps[]`
- [ ] `CONTACT_SECTION_SAMPLE: ContactSectionProps`
- [ ] Move all samples into own `samples/` sub-files (`samples/home.ts`, `samples/services.ts`, etc.) with barrel
- [ ] Confirm extraction boundary test: no personal content, all placeholder values

### Phase 1 — Publish

- [ ] Bump to `v0.2.0` after types split + new utils + samples complete
- [ ] Run full `build` + `typecheck` + `test` — all green
- [ ] Publish to npm (`npm publish --access public`)
- [ ] Tag git `v0.2.0`

---

## Phase 2 — Async Adapters (Consuming App)

No SDK changes — this phase happens in the **consuming app** (`alexrebula`). SDK surface is stable.

### Backend Setup

- [ ] Choose backend: Apollo/GraphQL + PostgreSQL **or** Supabase (pick one first, architect for swap-ability)
- [ ] Schema design: model section content as structured data (no raw HTML blobs)
  - `home_hero` table: name, role, avatar_path, highlights JSON
  - `expertise_areas` table: id, title, description, icon, direction, image_path
  - `testimonials` table: id, name, category, content, rating, posted_at, avatar_path
  - `faq_items` table: id, question, paragraphs JSON, page (home | services)
  - `service_packages` table: id, license, price, commons JSON, options JSON, is_featured
  - `about_hero` table: id, heading, intro, statement, experience, cta_href
- [ ] Seed development database with current static content
- [ ] Set up row-level security / auth guard so only authenticated owner can mutate

### Adapter Layer (consuming app, `sections-api/`)

- [ ] Convert `home/data.ts` factory functions to `async` — same return types, fetch from backend
- [ ] Convert `services/data.tsx` factory functions to `async`
- [ ] Convert `about/data.ts` factory functions to `async`
- [ ] Update `api.ts` orchestrator to `await` adapter calls
- [ ] Update Next.js page components to `async` where needed (App Router server components)
- [ ] Verify: zero component file changes required (all updates in `sections-api/` only)
- [ ] Confirm type safety end-to-end: backend response → adapter → typed props → component

### Testing

- [ ] Add integration tests for each adapter (mock fetch/client, assert typed output)
- [ ] Add E2E smoke test: page renders successfully with DB-sourced data

---

## Phase 3 — SDK Builders & Provider Interface

Builder logic extracted from consuming app into the SDK. Typed provider interface added.

### Provider Interface (`src/providers/index.ts`)

- [ ] Define `HomeViewContent` — minimal raw content shape (strings, no URLs assembled yet)
- [ ] Define `ServicesViewContent`
- [ ] Define `AboutViewContent`
- [ ] Define `WorkViewContent`
- [ ] Define `ContactViewContent`
- [ ] Define `SectionDataProvider` interface — one async getter per view
  ```ts
  export interface SectionDataProvider {
    getHomeViewContent(): Promise<HomeViewContent>;
    getServicesViewContent(): Promise<ServicesViewContent>;
    getAboutViewContent(): Promise<AboutViewContent>;
    // ...
  }
  ```
- [ ] Export all from `src/providers/index.ts`
- [ ] Add to `src/index.ts` barrel

### Builders (`src/builders/`)

One builder file per page domain. No backend knowledge, no credentials, no hardcoded content.

#### Home Builders (`src/builders/home.ts`)

- [ ] `buildHomeHeroData(content, params)` → `HomeHeroProps`
- [ ] `buildExpertiseAreasData(content, params)` → `ExpertiseAreasProps`
- [ ] `buildHomeIntegrationsData(content)` → `HomeIntegrationsProps`
- [ ] `buildHomeTestimonialsData(content)` → `HomeTestimonialsProps`
- [ ] `buildHomeFAQsData(content)` → `HomeFAQsProps`
- [ ] `buildHighlightFeaturesData(content)` → `HomeHighlightFeaturesSectionProps`
- [ ] `buildHugePackElementsData(content)` → `HugePackElementsSectionProps`
- [ ] `buildAdvertisementData(content, params)` → `AdvertisementSectionProps`
- [ ] `buildForDesignerData(content, params)` → `ForDesignerSectionProps`
- [ ] `buildHomePricingData(content, params)` → `PricingSectionProps`

#### Services Builders (`src/builders/services.ts`)

- [ ] `buildServicesPackagesData(content, params)` → `ServicePackageProps[]`
- [ ] `buildServicesProcessData(content)` → `ServiceProcessItemProps[]`
- [ ] `buildServicesDeliverablesData(content)` → `ServiceDeliverableProps[]`
- [ ] `buildServicesFAQsData(content)` → `HomeFAQsProps`

#### About Builders (`src/builders/about.ts`)

- [ ] `buildAboutHeroData(content, params)` → `AboutHeroProps`

#### Common Builders (`src/builders/common.ts`)

- [ ] `buildSectionButtonProps(content)` → `SectionButtonProps`
- [ ] `buildSectionIconButtonProps(content)` → `SectionIconButtonProps`

#### Barrel

- [ ] `src/builders/index.ts` re-exports all builders
- [ ] Add to `src/index.ts` barrel

### Client Factory (`src/client.ts`)

- [ ] `createSectionsClient(provider: SectionDataProvider)` — wires provider → builders
  ```ts
  return {
    async getHomeViewData(params) { ... },
    async getServicesViewData(params) { ... },
    async getAboutViewData(params) { ... },
  }
  ```
- [ ] Export `createSectionsClient` from `src/index.ts`

### Consuming App: Wire Up Client

- [ ] Update the consuming app's sections-api client to use `createSectionsClient`
- [ ] Implement `SectionDataProvider` interface as `ApolloSectionsProvider` (or `SupabaseSectionsProvider`)
- [ ] Verify: factory functions in `sections-api/` become thin one-liners
- [ ] Remove any builder logic that was duplicated between app and SDK

### Testing (Phase 3)

- [ ] Unit tests for every builder function (use sample content from `src/samples/`)
- [ ] Integration test: `createSectionsClient` with a mock provider returns correct typed output
- [ ] Confirm consuming app's adapter tests still pass after SDK wiring

### Phase 3 — Publish

- [ ] Bump to `v1.0.0` (first major: stable public API)
- [ ] Update `ARCHITECTURE.md` to reflect Phase 3 completion
- [ ] Update `README.md` with builder and client usage examples
- [ ] Run full `build` + `typecheck` + `test` — all green
- [ ] Publish to npm
- [ ] Tag git `v1.0.0`

---

## Phase 4 — CMS Admin Dashboard

Authenticated GUI for content owners to edit section content without code deploys.

- [ ] Choose admin UI approach: standalone Next.js admin app, or `/admin` route inside consuming app
- [ ] Set up Supabase Auth (owner-only, single-user)
- [ ] Admin auth guard: middleware protecting all `/admin/*` routes
- [ ] Section content editor: form-per-section, field-per-prop, save to DB
  - [ ] Home hero editor (name, role, avatar upload, highlights)
  - [ ] Expertise areas editor (sortable list, add/remove items)
  - [ ] Testimonials editor (add/edit/remove, rating, avatar upload)
  - [ ] FAQ editor (accordion items, question + paragraphs)
  - [ ] Services packages editor (pricing tiers, feature flags)
  - [ ] About hero editor (bio, statement, client logos)
- [ ] Image upload: Supabase Storage or S3-compatible bucket, returns public URL stored in DB
- [ ] Live preview pane: renders section with current form values using same typed components
- [ ] Publish / draft state: sections can be in draft before going live
- [ ] Change history / audit log (nice-to-have)
- [ ] Deploy admin separately from public portfolio (different Next.js app or separate route guard)

---

## Phase 5 — Multi-Client Platform

Second portfolio site proves the platform claim. No SDK modifications required.

- [ ] Create `client-two-portfolio/` (new Next.js app)
- [ ] Install `@alexrebula/giselle-sections-sdk` from npm
- [ ] Implement `SectionDataProvider` interface against client two's backend (Supabase or flat JSON)
- [ ] Wire `createSectionsClient` with client two's provider
- [ ] Render all sections — zero factory logic written from scratch
- [ ] Confirm: no SDK changes were needed to support the second client
- [ ] Document the "new client onboarding" steps in `README.md`
- [ ] Update `ARCHITECTURE.md` — Phase 5 complete, platform claim validated

---

## Cross-Cutting: Documentation

- [ ] `ARCHITECTURE.md` stays current as each phase completes (update relevant sections)
- [ ] `README.md` usage examples updated per phase (static → async → client factory)
- [ ] Inline JSDoc on all exported types and functions
- [ ] `CHANGELOG.md` — track breaking changes and additions per version
- [ ] Add `docs/` folder with:
  - [ ] `docs/getting-started.md` — install, wire up, first page
  - [ ] `docs/provider-guide.md` — how to implement `SectionDataProvider`
  - [ ] `docs/builders-reference.md` — all builder signatures and params
  - [ ] `docs/migration.md` — upgrading from Phase 1 static factories to Phase 3 client

---

## Cross-Cutting: Testing

- [ ] Unit tests: utils (100% coverage), samples validate against type shapes, builders
- [ ] Integration tests: `createSectionsClient` with mock provider
- [ ] Type-level tests (`expect<Type>().toEqual<ExpectedType>()` with `tsd` or `vitest` type checking)
- [ ] CI runs on all PRs: `typecheck` + `test` + `build`
- [ ] Test coverage threshold configured in `vitest.config.ts` (target ≥ 80%)

---

## Cross-Cutting: Publishing & Versioning

- [ ] Versioning follows SemVer: patch for fixes, minor for additive, major for breaking
- [ ] `npm publish` workflow: always `build` → `typecheck` → `test` → then publish
- [ ] Protect `main` branch: require CI green before merge
- [ ] GitHub releases: tag + release notes per version
- [ ] Provenance attestation: `npm publish --provenance` for supply-chain transparency

---

## Summary: What Each Phase Delivers

| Phase | What ships | Consuming app impact |
|-------|-----------|----------------------|
| 0 | Repo, build, CI | None |
| 1 | Types, utils, samples | Import types from package instead of defining locally |
| 2 | Async adapters | Same typed props, data from real backend — zero component changes |
| 3 | Builders + provider interface | Factory logic disappears from app, SDK owns construction |
| 4 | CMS admin dashboard | Content editable without code — marketing-level control |
| 5 | Second client | Platform validated — provider = install, implement interface, ship |
