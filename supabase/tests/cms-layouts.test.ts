import { beforeAll, describe, expect, it } from "vitest";

import { BUILTIN_SECTION_TEMPLATES } from "../../src/cms/template";
import { EDITOR, MEMBER, OWNER, as, createDatabase, parse, readMigration, visitor } from "./harness";

// Page layouts and their slot rules (allowed types and the maximum on every save, the minimum only at publish), the
// templates, assets and the change log, and the seeded built-in templates.

const d = createDatabase();
const { run, admin, must, makeItem, saveAndPublish, sql } = d;
const editor = as(EDITOR);
const owner = as(OWNER);

const section = (key: string, template: string, slots: Record<string, string[]>) => ({ key, template, slots });
const versionCount = async (page: string) =>
  Number((await admin(`select count(*) as n from cms_layout_versions v join cms_layouts l on l.id = v.layout_id where l.page_key = '${page}'`)).rows[0]!.n);

let banner: string;
let banner2: string;
let cards: string[];
let timeline: string;

beforeAll(async () => {
  await d.setup();
  banner = await makeItem("banner", "Banner", { reusable: true });
  banner2 = await makeItem("banner", "Banner two", { reusable: true });
  timeline = await makeItem("timeline", "Timeline", { reusable: true });
  cards = [];
  for (let i = 0; i < 3; i++) cards.push(await makeItem("card", `Card ${i}`, { reusable: true }));
});

describe("the built-in templates", () => {
  it("are seeded exactly as the SDK lists them", async () => {
    const rows = (await admin(`select key, name, container_type_key, slots, built_in from cms_templates order by key`)).rows;
    const expected = [...BUILTIN_SECTION_TEMPLATES]
      .map((t) => ({ key: t.key, name: t.name, container_type_key: t.containerTypeKey, slots: t.slots, built_in: true }))
      .sort((a, b) => a.key.localeCompare(b.key));
    expect(rows).toEqual(expected);
  });

  it("can be seeded again without changing anything", async () => {
    const before = (await admin(`select * from cms_templates order by key`)).rows;
    await d.db.exec(readMigration("20261115000600_cms_seed_templates.sql"));
    const after = (await admin(`select * from cms_templates order by key`)).rows;
    expect(after.map((r) => [r.key, r.name, r.slots, r.built_in])).toEqual(before.map((r) => [r.key, r.name, r.slots, r.built_in]));
  });
});

describe("slot rules on save", () => {
  it("saves a layout that follows the rules, with the item ids in order", async () => {
    const layout = { sections: [section("hero", "banner-section", { banner: [banner] }), section("help", "help-section", { cards })] };
    expect((await must(editor, sql.saveLayout("rules-ok", null, layout, [banner, ...cards])))[0]!.v).toBe(1);
    expect((await run(editor, `select * from cms_read_layout_newest('rules-ok')`)).rows[0]!.content).toEqual(layout);
  });

  it.each([
    ["an unknown template", () => [section("s", "no-such-template", {})], /no-such-template/],
    ["an unknown slot", () => [section("s", "banner-section", { nope: [] })], /no slot "nope"/],
    ["a type the slot does not allow", () => [section("s", "banner-section", { banner: [timeline] })], /does not allow/],
    ["a card in the banner slot", () => [section("s", "banner-section", { banner: [cards[0]!] })], /"card"/],
    ["too many items for the maximum", () => [section("s", "banner-section", { banner: [banner, banner2] })], /At most 1/],
    ["a slot that is not a list", () => [section("s", "banner-section", { banner: "x" as unknown as string[] })], /list of ids/],
    ["an id that is not an id", () => [section("s", "banner-section", { banner: ["abc"] })], /not an item id/],
  ])("CM004 for %s, naming the section and slot, and nothing is saved", async (_name, sections, message) => {
    const refused = await run(editor, sql.saveLayout("rules-bad", null, { sections: sections() }));
    expect(refused.code).toBe("CM004");
    const problems = parse(refused.detail);
    expect(problems[0]).toMatchObject({ section: "s" });
    expect(problems[0].message).toMatch(message);
    expect(await versionCount("rules-bad")).toBe(0);
  });

  it("reports every problem, one line each", async () => {
    const refused = await run(editor, sql.saveLayout("rules-bad", null, { sections: [section("a", "banner-section", { banner: [timeline] }), section("b", "nope", {})] }));
    expect(parse(refused.detail).map((p: { section: string }) => p.section)).toEqual(["a", "b"]);
  });

  it("a half-built page can be saved: the minimum is checked at publish only", async () => {
    const empty = await run(editor, sql.saveLayout("half-built", null, { sections: [section("hero", "banner-section", {}), section("tl", "timeline-section", { timeline: [] })] }));
    expect(empty.error).toBeUndefined();
  });

  it("content without a list of sections is invalid, and a bad page key too", async () => {
    expect((await run(editor, `select cms_save_layout_draft('bad-content', null, '{"sections": {}}'::jsonb, '{}')`)).code).toBe("22023");
    expect((await run(editor, `select cms_save_layout_draft('bad-content', null, '[]'::jsonb, '{}')`)).code).toBe("22023");
    expect((await run(editor, sql.saveLayout("Bad Key", null, { sections: [] }))).code).toBe("22023");
  });

  it("the stale rules of an item hold for a layout: CE001 with the newest version", async () => {
    await must(editor, sql.saveLayout("stale-page", null, { sections: [] }));
    await must(editor, sql.saveLayout("stale-page", 1, { sections: [section("a", "banner-section", {})] }));
    const stale = await run(editor, sql.saveLayout("stale-page", 1, { sections: [] }));
    expect(stale.code).toBe("CE001");
    expect(parse(stale.detail)).toMatchObject({ version: 2, status: "draft" });
    expect((await run(editor, sql.saveLayout("stale-page", null, { sections: [] }))).code).toBe("CE001");
    expect(await versionCount("stale-page")).toBe(2);
  });
});

describe("publish a layout", () => {
  it("CM007 when a slot is below its minimum, with the problem lines; nothing is published", async () => {
    await must(editor, sql.saveLayout("incomplete", null, { sections: [section("hero", "banner-section", {}), section("tl", "timeline-section", { timeline: [timeline] })] }, [timeline]));
    const refused = await run(editor, sql.publishLayout("incomplete", 1));
    expect(refused.code).toBe("CM007");
    expect(parse(refused.detail)).toEqual([{ section: "hero", slot: "banner", message: expect.stringMatching(/At least 1/) }]);
    expect((await admin(`select published_version from cms_layouts where page_key = 'incomplete'`)).rows[0]!.published_version).toBeNull();
    expect((await admin(`select count(*) as n from cms_change_log where action = 'publish_layout'`)).rows[0]!.n).toBe(0);
  });

  it("publishes once the minimum is met, and logs it", async () => {
    await must(editor, sql.saveLayout("incomplete", 1, { sections: [section("hero", "banner-section", { banner: [banner] }), section("tl", "timeline-section", { timeline: [timeline] })] }, [banner, timeline]));
    await must(editor, sql.publishLayout("incomplete", 2));
    expect((await admin(`select published_version from cms_layouts where page_key = 'incomplete'`)).rows[0]!.published_version).toBe(2);
    expect((await run(visitor, `select * from cms_read_layout('incomplete')`)).rows[0]).toMatchObject({ version: 2, status: "published" });
    const log = (await admin(`select action, version, user_id from cms_change_log where action = 'publish_layout' order by id`)).rows;
    expect(log).toEqual([{ action: "publish_layout", version: 2, user_id: EDITOR }]);
    // again: nothing changes and nothing is logged
    await must(editor, sql.publishLayout("incomplete", 2));
    expect((await admin(`select count(*) as n from cms_change_log where action = 'publish_layout'`)).rows[0]!.n).toBe(1);
  });

  it("only the newest version can be published (CE001)", async () => {
    await must(editor, sql.saveLayout("two-versions", null, { sections: [] }));
    await must(editor, sql.saveLayout("two-versions", 1, { sections: [section("a", "help-section", {})] }));
    const refused = await run(editor, sql.publishLayout("two-versions", 1));
    expect(refused.code).toBe("CE001");
    expect(parse(refused.detail)).toMatchObject({ version: 2 });
    expect((await run(editor, sql.publishLayout("two-versions", 3))).code).toBe("CE001");
    expect((await run(editor, sql.publishLayout("no-such-page", 1))).code).toBe("CM001");
  });

  it("a template that was tightened after the save is caught at publish (CM004)", async () => {
    await must(owner, `select cms_save_template('flex-section', 'Flex', 'section', '[{"key":"items","label":"Items","allowedTypeKeys":["card"],"min":0,"max":3}]'::jsonb)`);
    await must(editor, sql.saveLayout("tightened", null, { sections: [section("f", "flex-section", { items: cards })] }, cards));
    await must(owner, `select cms_save_template('flex-section', 'Flex', 'section', '[{"key":"items","label":"Items","allowedTypeKeys":["card"],"min":0,"max":2}]'::jsonb)`);
    expect((await run(editor, sql.publishLayout("tightened", 1))).code).toBe("CM004");
  });

  it("restore makes a new draft version with the old content and references", async () => {
    await must(editor, sql.saveLayout("restorable", null, { sections: [section("hero", "banner-section", { banner: [banner] })] }, [banner]));
    await must(editor, sql.publishLayout("restorable", 1));
    await must(editor, sql.saveLayout("restorable", 1, { sections: [] }));
    expect((await must(editor, sql.restoreLayout("restorable", 1, 2)))[0]!.v).toBe(3);
    const versions = (await run(editor, `select version, status, restored_from from cms_list_layout_versions('restorable')`)).rows;
    expect(versions).toEqual([
      { version: 3, status: "draft", restored_from: 1 },
      { version: 2, status: "draft", restored_from: null },
      { version: 1, status: "published", restored_from: null },
    ]);
    expect((await admin(`select r.source_version, r.target_item_id from cms_references r join cms_layouts l on l.id = r.source_id where l.page_key = 'restorable' and r.source_version = 3`)).rows).toEqual([{ source_version: 3, target_item_id: banner }]);
    expect((await run(editor, sql.restoreLayout("restorable", 1, 1))).code).toBe("CE001");
    expect((await run(editor, sql.restoreLayout("restorable", 9, 3))).code).toBe("22023");
    expect((await run(editor, sql.restoreLayout("no-such-page", 1, 1))).code).toBe("CM001");
  });
});

describe("reorder a slot", () => {
  const reorder = (base: number, sectionKey: string, slotKey: string, ids: string[]) =>
    `select cms_reorder_slot('reorder-page', ${base}, '${sectionKey}', '${slotKey}', ${d.uuids(ids)}) as v`;

  beforeAll(async () => {
    await must(editor, sql.saveLayout("reorder-page", null, { sections: [section("help", "help-section", { cards })] }, cards));
  });

  it("saves a new draft version with the slot in the new order", async () => {
    const [a, b, c] = cards as [string, string, string];
    expect((await must(editor, reorder(1, "help", "cards", [c, a, b])))[0]!.v).toBe(2);
    const newest = (await run(editor, `select * from cms_read_layout_newest('reorder-page')`)).rows[0]!;
    expect(newest.content.sections[0].slots.cards).toEqual([c, a, b]);
    expect(newest.version).toBe(2);
    expect((await admin(`select count(*) as n from cms_references r join cms_layouts l on l.id = r.source_id where l.page_key = 'reorder-page' and r.source_version = 2`)).rows[0]!.n).toBe(3);
  });

  it("CE001 when the base is not the newest layout version", async () => {
    const stale = await run(editor, reorder(1, "help", "cards", [...cards]));
    expect(stale.code).toBe("CE001");
    expect(parse(stale.detail)).toMatchObject({ version: 2 });
  });

  it("refuses a list that adds, drops or repeats an item (22023), and an unknown section", async () => {
    const [a, b, c] = cards as [string, string, string];
    expect((await run(editor, reorder(2, "help", "cards", [a, b]))).code).toBe("22023");
    expect((await run(editor, reorder(2, "help", "cards", [a, b, c, banner]))).code).toBe("22023");
    expect((await run(editor, reorder(2, "help", "cards", [a, a, b]))).code).toBe("22023");
    expect((await run(editor, reorder(2, "nope", "cards", [a, b, c]))).code).toBe("22023");
    expect((await run(editor, `select cms_reorder_slot('reorder-page', 2, 'help', 'cards', null)`)).code).toBe("22023");
    expect((await run(editor, `select cms_reorder_slot('no-such-page', 1, 'help', 'cards', '{}')`)).code).toBe("CM001");
    expect(await versionCount("reorder-page")).toBe(2);
  });
});

describe("templates", () => {
  const save = (key: string, slots: unknown, name = "Name", container = "section") =>
    `select * from cms_save_template('${key}', '${name}', '${container}', ${d.json(slots)})`;
  const slot = { key: "items", label: "Items", allowedTypeKeys: ["card"], min: 0, max: 4 };

  it("only an owner saves one; the row is created and then replaced", async () => {
    expect((await run(editor, save("mine-section", [slot]))).code).toBe("42501");
    expect((await run(as(MEMBER), save("mine-section", [slot]))).code).toBe("42501");
    await must(owner, save("mine-section", [slot]));
    await must(owner, save("mine-section", [{ ...slot, max: null }], "Renamed"));
    expect((await admin(`select name, slots, built_in from cms_templates where key = 'mine-section'`)).rows).toEqual([{ name: "Renamed", slots: [{ ...slot, max: null }], built_in: false }]);
  });

  it.each([
    ["no slots", []],
    ["slots that are not a list", { key: "a" }],
    ["a bad slot key", [{ ...slot, key: "Bad Key" }]],
    ["a repeated slot key", [slot, slot]],
    ["no allowed types", [{ ...slot, allowedTypeKeys: [] }]],
    ["a bad allowed type", [{ ...slot, allowedTypeKeys: ["Not A Key"] }]],
    ["a minimum above the maximum", [{ ...slot, min: 5, max: 2 }]],
    ["a maximum over 100", [{ ...slot, max: 101 }]],
    ["a negative minimum", [{ ...slot, min: -1 }]],
    ["a fractional maximum", [{ ...slot, max: 1.5 }]],
    ["a stray field", [{ ...slot, colour: "red" }]],
    ["an empty label", [{ ...slot, label: "" }]],
  ])("refuses %s (22023)", async (_name, slots) => {
    expect((await run(owner, save("bad-template", slots))).code).toBe("22023");
  });

  it("refuses a bad key, name or container (22023)", async () => {
    expect((await run(owner, save("Bad Key", [slot]))).code).toBe("22023");
    expect((await run(owner, save("fine-key", [slot], ""))).code).toBe("22023");
    expect((await run(owner, save("fine-key", [slot], "x".repeat(81)))).code).toBe("22023");
    expect((await run(owner, save("fine-key", [slot], "Name", "Bad Container"))).code).toBe("22023");
  });

  it("a built-in stays built in, and no template is ever deleted", async () => {
    await must(owner, save("banner-section", [{ ...slot, key: "banner", allowedTypeKeys: ["banner"], min: 1, max: 1 }], "Banner section"));
    expect((await admin(`select built_in from cms_templates where key = 'banner-section'`)).rows[0]!.built_in).toBe(true);
    expect((await admin(`update cms_templates set built_in = false where key = 'banner-section'`)).error).toMatch(/stays built in/);
    expect((await admin(`delete from cms_templates where key = 'mine-section'`)).error).toMatch(/cannot be deleted/);
    expect((await admin(`delete from cms_templates where key = 'banner-section'`)).error).toMatch(/cannot be deleted/);
  });

  it("is written to the change log", async () => {
    expect((await admin(`select user_id, detail from cms_change_log where action = 'save_template' order by id limit 1`)).rows[0]).toMatchObject({ user_id: OWNER, detail: { key: expect.any(String) } });
  });
});

describe("assets", () => {
  const register = (path: string, mime = "image/png", bytes = 1000) => `select * from cms_register_asset('${path}', '${mime}', ${bytes}, 800, 600, 'A label')`;

  beforeAll(async () => {
    await admin(`insert into storage.buckets (id, name) values ('other-bucket', 'other-bucket')`);
    // a file in another bucket does not count
    await admin(`insert into storage.objects (bucket_id, name) values ('site-images', 'photos/one.png'), ('site-images', 'photos/two.webp'), ('other-bucket', 'photos/elsewhere.png')`);
  });

  it("registers a file that is in the bucket, once, and logs it", async () => {
    const first = await must(editor, register("photos/one.png"));
    expect(first[0]).toMatchObject({ bucket: "site-images", path: "photos/one.png", mime: "image/png", bytes: 1000, width: 800, height: 600, label: "A label", created_by: EDITOR });
    const again = await must(owner, register("photos/one.png", "image/webp", 5));
    expect(again[0]!.id).toBe(first[0]!.id);
    expect(again[0]!.mime).toBe("image/png"); // the existing row, unchanged
    expect((await admin(`select count(*) as n from cms_assets`)).rows[0]!.n).toBe(1);
    expect((await admin(`select count(*) as n from cms_change_log where action = 'register_asset'`)).rows[0]!.n).toBe(1);
  });

  it("CM006 for a file that is not in the bucket, and for a path, type or size that is not allowed", async () => {
    for (const statement of [
      register("photos/missing.png"),
      register("photos/elsewhere.png"),
      register("/photos/one.png"),
      register("photos/../one.png"),
      register(".."),
      register("photos/one.png", "image/gif"),
      register("photos/two.webp", "application/pdf"),
      register("photos/two.webp", "image/webp", 0),
      register("photos/two.webp", "image/webp", 5242881),
      `select * from cms_register_asset('photos/two.webp', 'image/webp', 10, 0, 5, null)`,
      `select * from cms_register_asset('photos/two.webp', 'image/webp', 10, 5, 5, '${"x".repeat(201)}')`,
    ]) {
      expect((await run(editor, statement)).code, statement).toBe("CM006");
    }
    expect((await run(editor, register("photos/two.webp", "image/webp", 5242880))).error).toBeUndefined();
  });

  it("anyone reads the safe columns of every asset; nobody changes or deletes one", async () => {
    const seen = await run(visitor, `select id, bucket, path, mime, width, height, label, created_at from cms_assets`);
    expect(seen.rows).toHaveLength(1);
    expect((await admin(`update cms_assets set label = 'x'`)).error).toMatch(/append-only/);
    expect((await admin(`delete from cms_assets`)).error).toMatch(/append-only/);
  });
});

describe("the change log", () => {
  it("records publishes, deletes, template saves and asset registrations, and cannot be changed", async () => {
    const item = await makeItem("card", "logged");
    await saveAndPublish(item, "en", { t: 1 });
    await must(owner, `select cms_delete_item('${item}')`);
    const actions = (await admin(`select distinct action from cms_change_log order by 1`)).rows.map((r) => r.action);
    expect(actions).toEqual(["delete_item", "publish_item", "publish_layout", "register_asset", "save_template"]);
    expect((await admin(`update cms_change_log set action = 'publish_item'`)).error).toMatch(/append-only/);
    expect((await admin(`delete from cms_change_log`)).error).toMatch(/append-only/);
    expect((await admin(`truncate cms_change_log`)).error).toMatch(/append-only/);
    expect((await admin(`insert into cms_change_log (action) values ('something_else')`)).error).toMatch(/check constraint/);
  });
});
