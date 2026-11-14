import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createCmsProvider } from "../../src/cms/cms-provider";
import { createContentTypeRegistry } from "../../src/cms/create-registry";
import { ContentNotFoundError, ContentPermissionError, PageTakenError } from "../../src/cms/errors";
import { createSupabaseCmsStore } from "../../src/cms/supabase-store";
import { EDITOR, MEMBER, STRANGER, as, createDatabase, visitor, type Who } from "./harness";
import { pgliteClient } from "./pglite-client";

// The TypeScript Supabase store and the provider over the real SQL functions: what a page read returns to each role, and
// the pages an editor makes.

const d = createDatabase();
let caller: Who = visitor;
const store = createSupabaseCmsStore(pgliteClient(d.db, () => caller));

const registry = createContentTypeRegistry();
registry.register({ key: "section", label: "Section", kind: "container", storage: "document", translatable: false, schema: z.object({}), component: "Section", slots: [{ key: "banner", label: "Banner", allowedTypeKeys: ["banner"], min: 0, max: 1 }] });
registry.register({ key: "banner", label: "Banner", kind: "block", storage: "document", translatable: true, schema: z.object({ title: z.string() }), component: "Banner" });
registry.validate();
const provider = createCmsProvider({ store, registry, reservedSlugs: ["/blog", "contact"] });

const editor = as(EDITOR);
const roles: [string, Who][] = [
  ["a visitor", visitor],
  ["a member", as(MEMBER)],
  ["a signed-in stranger", as(STRANGER)],
];

beforeAll(async () => {
  await d.setup();
  const banner = await d.makeItem("banner", "Banner", { reusable: true });
  await d.saveAndPublish(banner, "en", { title: "Live" });
  const live = { sections: [{ key: "hero", template: "banner-section", slots: { banner: [banner] } }] };
  await d.must(editor, d.sql.saveLayout("home", null, live, [banner]));
  await d.must(editor, d.sql.publishLayout("home", 1));
  const draft = { sections: [...live.sections, { key: "more", template: "banner-section", slots: {} }] };
  await d.must(editor, d.sql.saveLayout("home", 1, draft, [banner]));
});

describe("a page layout read for a page", () => {
  it.each(roles)("gives %s who asks for a preview the published layout, not an error", async (_name, who) => {
    caller = who;
    expect(await store.layouts.read("home", true)).toMatchObject({ pageKey: "home", version: 1, status: "published", isDraft: false });
    const page = await provider.page("home", "en", { preview: true });
    expect(page).toMatchObject({ version: 1, isDraft: false });
    expect(page?.sections.map((section) => section.key)).toEqual(["hero"]);
  });

  it("gives an editor who asks for a preview the newest draft", async () => {
    caller = editor;
    expect(await store.layouts.read("home", true)).toMatchObject({ version: 2, status: "draft", isDraft: true });
    const page = await provider.page("home", "en", { preview: true });
    expect(page).toMatchObject({ version: 2, isDraft: true });
    expect(page?.sections.map((section) => section.key)).toEqual(["hero", "more"]);
  });

  it("gives everyone the published layout without a preview", async () => {
    for (const [, who] of [...roles, ["an editor", editor] as [string, Who]]) {
      caller = who;
      expect(await store.layouts.read("home", false)).toMatchObject({ version: 1, isDraft: false });
      expect(await provider.page("home", "en")).toMatchObject({ version: 1, isDraft: false });
    }
  });

  it("gives null for a page that has no layout", async () => {
    caller = visitor;
    expect(await store.layouts.read("nowhere", true)).toBeNull();
    expect(await provider.page("nowhere", "en", { preview: true })).toBeNull();
  });
});

describe("pages an editor makes, through the store and the provider", () => {
  const rejects = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return error;
    }
    throw new Error("expected a rejection");
  };

  it("creates a page with an empty draft, shown to nobody but an editor in preview until it is published", async () => {
    caller = editor;
    const page = await provider.createPage({ pageKey: "about", slug: "about-us", titles: { en: "About us", de: "Über uns" }, descriptions: { en: "Who we are" } });
    expect(page).toMatchObject({ pageKey: "about", slug: "about-us", titles: { en: "About us", de: "Über uns" }, descriptions: { en: "Who we are" }, publishedVersion: null });
    expect(await provider.layoutDraft("about")).toMatchObject({ version: 1, content: { sections: [] } });
    expect(await provider.pageBySlug("about-us", "de", { preview: true })).toMatchObject({
      pageKey: "about",
      slug: "about-us",
      version: 1,
      isDraft: true,
      sections: [],
      meta: { title: "Über uns", titleLanguage: "de", description: "Who we are" },
    });
    expect(await provider.pageBySlug("about-us", "en")).toBeNull();
    for (const [, who] of roles) {
      caller = who;
      expect(await provider.pageBySlug("about-us", "en", { preview: true })).toBeNull();
    }

    caller = editor;
    await provider.publishLayout("about", 1);
    for (const [, who] of roles) {
      caller = who;
      expect(await provider.pageBySlug("about-us", "sl", { preview: true })).toMatchObject({ version: 1, isDraft: false, meta: { title: "About us", titleLanguage: "en" } });
    }
  });

  it("refuses a taken address, a taken key and a reserved address with PageTakenError, saying which", async () => {
    caller = editor;
    expect(await rejects(provider.createPage({ pageKey: "other", slug: "about-us", titles: { en: "x" } }))).toMatchObject({ name: "PageTakenError", field: "slug", value: "about-us", reason: "taken" });
    expect(await rejects(provider.createPage({ pageKey: "home", slug: "home-two", titles: { en: "x" } }))).toMatchObject({ field: "pageKey", value: "home", reason: "taken" });
    const reserved = await rejects(provider.createPage({ pageKey: "blogish", slug: "blog", titles: { en: "x" } }));
    expect(reserved).toBeInstanceOf(PageTakenError);
    expect(reserved).toMatchObject({ field: "slug", value: "blog", reason: "reserved" });
    expect(await rejects(provider.updatePage("about", { slug: "contact" }))).toMatchObject({ reason: "reserved" });
  });

  it("changes and lists pages for editors only", async () => {
    caller = editor;
    expect(await provider.updatePage("about", { slug: "about" })).toMatchObject({ slug: "about", titles: { en: "About us", de: "Über uns" }, publishedVersion: 1 });
    expect((await provider.pages()).map((page) => page.slug)).toEqual(["about"]);
    expect(await rejects(provider.updatePage("nope", { slug: "nope" }))).toBeInstanceOf(ContentNotFoundError);
    caller = as(STRANGER);
    expect(await provider.pages()).toEqual([]);
    caller = visitor;
    expect(await rejects(provider.pages())).toBeInstanceOf(ContentPermissionError); // not granted to visitors at all
    expect(await rejects(provider.createPage({ pageKey: "sneaky", slug: "sneaky", titles: { en: "x" } }))).toBeInstanceOf(ContentPermissionError);
  });
});
