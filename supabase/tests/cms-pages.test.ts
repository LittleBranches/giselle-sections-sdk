import { beforeAll, describe, expect, it } from "vitest";

import { EDITOR, MEMBER, OWNER, STRANGER, as, createDatabase, migrationFiles, parse, visitor, type Who } from "./harness";

// Pages an editor makes (20261117090000_cms_pages.sql): an address and words around an ordinary layout, created with an
// empty draft, shown to visitors only once published.

const d = createDatabase();
const { run, admin, must, makeItem, sql, json, lit } = d;
const editor = as(EDITOR);
const owner = as(OWNER);
const lowRoles: [string, Who][] = [
  ["a visitor", visitor],
  ["a member", as(MEMBER)],
  ["a stranger", as(STRANGER)],
];

const create = (key: string, slug: string, titles: object = { en: "Title" }, descriptions?: object) =>
  `select * from cms_create_page(${lit(key)}, ${lit(slug)}, ${json(titles)}${descriptions ? `, ${json(descriptions)}` : ""})`;
const bySlug = (slug: string, preview = false) => `select * from cms_read_page_by_slug(${lit(slug)}, ${preview})`;

let banner: string;

beforeAll(async () => {
  await d.setup();
  banner = await makeItem("banner", "Banner", { reusable: true });
  await d.saveAndPublish(banner, "en", { title: "Hello" });
  // a fixed route's layout, made the old way
  await must(editor, sql.saveLayout("home", null, { sections: [] }));
});

describe("the shared migration files", () => {
  it("are the six of the content model and the pages file, in this order", () => {
    expect(migrationFiles().filter((file) => file.includes("_cms_"))).toEqual([
      "20261115000100_cms_roles.sql",
      "20261115000200_cms_legacy_entries.sql",
      "20261115000300_cms_images_bucket.sql",
      "20261115000400_cms_tables.sql",
      "20261115000500_cms_functions.sql",
      "20261115000600_cms_seed_templates.sql",
      "20261117090000_cms_pages.sql",
    ]);
  });
});

describe("creating a page", () => {
  it("makes the page and its layout with an empty draft, and logs it", async () => {
    const [row] = await must(editor, create("about", "about-us", { en: "About us", sl: "O nas" }, { en: "Who we are" }));
    expect(row).toMatchObject({ page_key: "about", slug: "about-us", titles: { en: "About us", sl: "O nas" }, descriptions: { en: "Who we are" }, published_version: null });
    expect(row).not.toHaveProperty("created_by_email");
    expect((await run(editor, `select * from cms_read_layout_newest('about')`)).rows[0]).toMatchObject({ version: 1, status: "draft", content: { sections: [] } });
    const logged = await admin(`select action, detail from cms_change_log where action = 'create_page'`);
    expect(logged.rows).toEqual([{ action: "create_page", detail: { pageKey: "about", slug: "about-us" } }]);
  });

  it("refuses a taken address with CM009 naming the slug, and nothing is made", async () => {
    const refused = await run(editor, create("about-two", "about-us"));
    expect(refused.code).toBe("CM009");
    expect(parse(refused.detail)).toEqual({ field: "slug", value: "about-us" });
    expect((await admin(`select count(*)::int as n from cms_layouts where page_key = 'about-two'`)).rows[0]!.n).toBe(0);
  });

  it("refuses a page key that a fixed route's layout or another page already has, with CM009 naming the key", async () => {
    for (const key of ["home", "about"]) {
      const refused = await run(editor, create(key, `fresh-${key}`));
      expect(refused.code, key).toBe("CM009");
      expect(parse(refused.detail)).toEqual({ field: "pageKey", value: key });
    }
  });

  it.each([
    ["an address with capitals", () => create("p1", "About")],
    ["an address with a double hyphen", () => create("p1", "a--b")],
    ["an address with a slash", () => create("p1", "a/b")],
    ["an address over 100 characters", () => create("p1", "a".repeat(101))],
    ["a bad page key", () => create("1p", "p-one")],
    ["no English title", () => create("p1", "p-one", { sl: "Naslov" })],
    ["an empty title", () => create("p1", "p-one", { en: "  " })],
    ["a title that is not text", () => create("p1", "p-one", { en: 5 })],
    ["a title over 120 characters", () => create("p1", "p-one", { en: "x".repeat(121) })],
    ["a language code that is not one", () => create("p1", "p-one", { en: "T", english: "T" })],
    ["a description over 300 characters", () => create("p1", "p-one", { en: "T" }, { en: "x".repeat(301) })],
  ])("refuses %s with 22023", async (_name, statement) => {
    expect((await run(editor, statement())).code).toBe("22023");
  });

  it.each(lowRoles)("refuses %s with 42501", async (_name, who) => {
    expect((await run(who, create("p2", "p-two"))).code).toBe("42501");
  });

  it("lets an owner create a page too", async () => {
    expect((await must(owner, create("owned", "owned")))[0]).toMatchObject({ slug: "owned" });
  });
});

describe("reading a page by its address", () => {
  beforeAll(async () => {
    await must(editor, create("news", "news", { en: "News" }));
    const layout = { sections: [{ key: "hero", template: "banner-section", slots: { banner: [banner] } }] };
    await must(editor, sql.saveLayout("news", 1, layout, [banner]));
  });

  it.each(lowRoles)("shows %s nothing while the page is unpublished, preview or not", async (_name, who) => {
    expect((await run(who, bySlug("news"))).rows).toEqual([]);
    expect((await run(who, bySlug("news", true))).rows).toEqual([]);
    expect((await run(who, `select slug from cms_pages where slug = 'news'`)).rows).toEqual([]);
  });

  it("shows an editor the newest draft in preview, and nothing without it", async () => {
    expect((await run(editor, bySlug("news"))).rows).toEqual([]);
    expect((await run(editor, bySlug("news", true))).rows[0]).toMatchObject({ page_key: "news", slug: "news", version: 2, status: "draft", is_draft: true, published_version: null });
  });

  it("shows everyone the published version once published, and an editor in preview the newer draft", async () => {
    await must(editor, sql.publishLayout("news", 2));
    await must(editor, sql.saveLayout("news", 2, { sections: [] }));
    for (const [name, who] of lowRoles) {
      expect((await run(who, bySlug("news", true))).rows[0], name).toMatchObject({ version: 2, status: "published", is_draft: false, titles: { en: "News" }, published_version: 2 });
      expect((await run(who, `select slug, titles from cms_pages where slug = 'news'`)).rows, name).toEqual([{ slug: "news", titles: { en: "News" } }]);
    }
    expect((await run(editor, bySlug("news", true))).rows[0]).toMatchObject({ version: 3, is_draft: true });
  });

  it("gives nothing for an address no page has", async () => {
    expect((await run(editor, bySlug("nowhere", true))).rows).toEqual([]);
  });
});

describe("changing and listing pages", () => {
  beforeAll(async () => {
    await must(editor, create("events", "events", { en: "Events" }));
  });

  it("changes the address and the words, leaving what is not given", async () => {
    const [row] = await must(editor, `select * from cms_update_page('events', p_slug => 'whats-on', p_titles => ${json({ en: "What's on", de: "Programm" })})`);
    expect(row).toMatchObject({ page_key: "events", slug: "whats-on", titles: { en: "What's on", de: "Programm" }, descriptions: {} });
    const [again] = await must(editor, `select * from cms_update_page('events', p_descriptions => ${json({ en: "Dates" })})`);
    expect(again).toMatchObject({ slug: "whats-on", titles: { en: "What's on", de: "Programm" }, descriptions: { en: "Dates" } });
    expect((await admin(`select count(*)::int as n from cms_change_log where action = 'update_page'`)).rows[0]!.n).toBe(2);
  });

  it("refuses a taken address (CM009), a bad one (22023), an unknown page (CM001), and a visitor (42501)", async () => {
    const taken = await run(editor, `select * from cms_update_page('events', p_slug => 'news')`);
    expect(taken.code).toBe("CM009");
    expect(parse(taken.detail)).toEqual({ field: "slug", value: "news" });
    expect((await run(editor, `select * from cms_update_page('events', p_titles => ${json({ de: "x" })})`)).code).toBe("22023");
    const missing = await run(editor, `select * from cms_update_page('nope', p_slug => 'x')`);
    expect(missing.code).toBe("CM001");
    expect(parse(missing.detail)).toEqual({ kind: "page", id: "nope" });
    expect((await run(visitor, `select * from cms_update_page('events', p_slug => 'x')`)).code).toBe("42501");
  });

  it("keeps an address the page already has", async () => {
    expect((await run(editor, `select * from cms_update_page('events', p_slug => 'whats-on')`)).error).toBeUndefined();
  });

  it("lists every page to editors by address, and nothing to anyone else", async () => {
    const listed = (await run(editor, `select slug, published_version from cms_list_pages()`)).rows;
    expect(listed.map((r) => r.slug)).toEqual(["about-us", "news", "owned", "whats-on"]);
    expect(listed.find((r) => r.slug === "news")!.published_version).toBe(2);
    for (const [, who] of lowRoles) expect((await run(who, `select * from cms_list_pages()`)).rows).toEqual([]);
  });
});

describe("what nobody can do", () => {
  it("delete a page or change its key or layout, even as the table owner", async () => {
    expect((await admin(`delete from cms_pages where page_key = 'about'`)).error).toMatch(/append-only/);
    expect((await admin(`update cms_pages set page_key = 'other' where page_key = 'about'`)).error).toMatch(/Only the slug/);
    expect((await admin(`update cms_pages set slug = 'Bad Slug' where page_key = 'about'`)).error).toBeTruthy();
  });

  it("read who made a page", async () => {
    for (const [, who] of [...lowRoles, ["an editor", editor] as [string, Who]]) {
      expect((await run(who, `select created_by_email from cms_pages`)).error).toMatch(/permission denied/);
    }
  });
});
