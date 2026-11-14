import { beforeAll, describe, expect, it } from "vitest";

import { EDITOR, MEMBER, OWNER, STRANGER, as, createDatabase, parse, visitor, type Who } from "./harness";

// Who may see and do what, per role, on the content model's tables and functions: visitor (no sign-in), member and
// stranger (signed in, same as a visitor for content), editor and owner.

const d = createDatabase();
const { run, admin, must, makeItem, saveAndPublish, sql } = d;

const DENIED = /permission denied|row-level security|Only editors and owners|Only owners/;

const roles: [string, Who][] = [
  ["visitor", visitor],
  ["member", as(MEMBER)],
  ["stranger", as(STRANGER)],
  ["editor", as(EDITOR)],
  ["owner", as(OWNER)],
];
const lowRoles = roles.slice(0, 3);
const canEdit = roles.slice(3);

let live: string; // translatable: en published, sl draft only
let fixed: string; // not translatable: 'all' published
let draftOnly: string; // saved, never published
let bannerId: string;

beforeAll(async () => {
  await d.setup();
  live = await makeItem("card", "Live card", { reusable: true });
  await saveAndPublish(live, "en", { text: "English v1" });
  await must(as(EDITOR), sql.save(live, "sl", null, { text: "Slovenski osnutek" }));
  await saveAndPublish(live, "en", { text: "English v2" });
  await must(as(EDITOR), sql.save(live, "en", 2, { text: "English draft" }));

  fixed = await makeItem("card", "Fixed card", { translatable: false });
  await saveAndPublish(fixed, "all", { text: "Same everywhere" });

  draftOnly = await makeItem("card", "Secret draft", {});
  await must(as(EDITOR), sql.save(draftOnly, "en", null, { text: "Not yet" }));

  bannerId = await makeItem("banner", "Banner", { reusable: true });
  await saveAndPublish(bannerId, "en", { text: "Banner" });
  await saveAndPublish(live, "de", { text: "Deutsch" }, [bannerId]);
  await must(as(EDITOR), sql.saveLayout("home", null, { sections: [{ key: "top", template: "banner-section", slots: { banner: [bannerId] } }] }, [bannerId]));
  await must(as(EDITOR), sql.publishLayout("home", 1));
  await must(as(EDITOR), sql.saveLayout("home", 1, { sections: [{ key: "top", template: "banner-section", slots: { banner: [bannerId] } }] }, [bannerId]));
});

describe("the tables, through the API", () => {
  it.each(roles)("%s: no insert, update or delete on any table", async (_name, who) => {
    const tables = (await admin(`select tablename from pg_tables where schemaname = 'public' and tablename like 'cms\\_%' order by 1`)).rows.map((r) => r.tablename);
    expect(tables.length).toBe(10);
    for (const table of tables) {
      const column = (await admin(`select column_name from information_schema.columns where table_name = '${table}' and is_identity = 'NO' order by ordinal_position limit 1`)).rows[0]!.column_name;
      for (const statement of [`insert into ${table} default values`, `update ${table} set ${column} = ${column}`, `delete from ${table}`]) {
        const outcome = await run(who, statement);
        expect(outcome.error, `${who.role} ${statement}`).toMatch(DENIED);
      }
    }
  });

  it.each(roles)("%s: reads only published rows and only the safe columns", async (_name, who) => {
    const items = await run(who, `select id, type_key, reusable, translatable, created_at from cms_items order by created_at`);
    expect(items.error).toBeUndefined();
    const ids = items.rows.map((r) => r.id);
    expect(ids).toContain(live);
    expect(ids).toContain(fixed);
    expect(ids).not.toContain(draftOnly); // an item with no published entry does not exist for a reader of the table

    const entries = await run(who, `select item_id, language, published_version from cms_item_entries where item_id = '${live}' order by language`);
    expect(entries.rows.map((r) => r.language)).toEqual(["de", "en"]); // the draft-only sl entry is hidden

    const versions = await run(
      who,
      `select e.language, v.version, v.status, v.content from cms_item_versions v join cms_item_entries e on e.id = v.entry_id where e.item_id = '${live}' order by e.language`,
    );
    // only each entry's published version: en v2 (not v3 draft, not v1), de v1
    expect(versions.rows.map((r) => `${r.language}${r.version}${r.status}`)).toEqual(["de1published", "en2published"]);
    expect(JSON.stringify(versions.rows)).not.toContain("English draft");
    expect(JSON.stringify(versions.rows)).not.toContain("Slovenski");

    const layouts = await run(who, `select page_key, published_version from cms_layouts`);
    expect(layouts.rows).toEqual([{ page_key: "home", published_version: 1 }]);
    const layoutVersions = await run(who, `select version, status from cms_layout_versions`);
    expect(layoutVersions.rows).toEqual([{ version: 1, status: "published" }]); // not the draft v2

    expect((await run(who, `select key from cms_templates`)).rows.length).toBeGreaterThanOrEqual(3);
  });

  it.each(roles)("%s: cannot read who saved what, titles, or the reference index", async (_name, who) => {
    for (const statement of [
      `select title from cms_items`,
      `select created_by from cms_items`,
      `select created_by_email from cms_items`,
      `select * from cms_items`,
      `select changed_by from cms_item_versions`,
      `select changed_by_email from cms_item_versions`,
      `select changed_by_email from cms_layout_versions`,
      `select created_by_email from cms_assets`,
      `select * from cms_references`,
      `select target_item_id from cms_references`,
    ]) {
      expect((await run(who, statement)).error, statement).toMatch(/permission denied/);
    }
  });

  it("the change log is for editors and owners only", async () => {
    expect((await run(visitor, `select * from cms_change_log`)).error).toMatch(/permission denied/);
    for (const [, who] of [roles[1]!, roles[2]!]) expect((await run(who, `select * from cms_change_log`)).rows).toEqual([]);
    for (const [name, who] of canEdit) {
      const log = await run(who, `select action from cms_change_log order by id`);
      expect(log.rows.length, name).toBeGreaterThan(0);
    }
  });
});

describe("reads for everyone", () => {
  it.each(roles)("%s: cms_read_published gives the live version, never a draft", async (_name, who) => {
    const en = await run(who, `select * from cms_read_published('${live}', 'en')`);
    expect(en.rows.length).toBe(1);
    expect(en.rows[0]).toMatchObject({ version: 2, status: "published", content: { text: "English v2" } });
    expect((await run(who, `select * from cms_read_published('${live}', 'sl')`)).rows).toEqual([]); // draft only
    expect((await run(who, `select * from cms_read_published('${draftOnly}', 'en')`)).rows).toEqual([]);
    expect((await run(who, `select * from cms_read_published('${live}', 'fr')`)).rows).toEqual([]); // no fallback here
  });

  it.each(lowRoles)("%s: cms_resolve_items shows no draft, even when preview is asked for (a forged flag shows nothing extra)", async (_name, who) => {
    for (const preview of ["false", "true"]) {
      const slResult = await run(who, `select * from cms_resolve_items(array['${live}']::uuid[], 'sl', ${preview})`);
      expect(slResult.rows.length).toBe(1);
      // the sl entry has only a draft, so the visitor falls back to the published English words
      expect(slResult.rows[0]).toMatchObject({ language: "en", version: 2, is_draft: false, content: { text: "English v2" } });
      const none = await run(who, `select * from cms_resolve_items(array['${draftOnly}']::uuid[], 'en', ${preview})`);
      expect(none.rows).toEqual([]);
    }
    const layout = await run(who, `select * from cms_read_layout('home', true)`);
    expect(layout.rows.length).toBe(1);
    expect(layout.rows[0]).toMatchObject({ version: 1, status: "published", is_draft: false });
  });

  it.each(canEdit)("%s: preview is the editor's own rule: newest versions, drafts marked", async (_name, who) => {
    const asked = `array['${live}','${fixed}','${draftOnly}']::uuid[]`;
    const plain = await run(who, `select * from cms_resolve_items(${asked}, 'sl')`);
    expect(plain.rows.map((r) => r.item_id).sort()).toEqual([live, fixed].sort()); // preview off: same as a visitor
    expect(plain.rows.find((r) => r.item_id === live)).toMatchObject({ language: "en", is_draft: false, version: 2 });

    const preview = await run(who, `select * from cms_resolve_items(${asked}, 'sl', true)`);
    const byItem = Object.fromEntries(preview.rows.map((r) => [r.item_id, r]));
    // the Slovenian draft beats the published English entry in a preview
    expect(byItem[live]).toMatchObject({ language: "sl", version: 1, status: "draft", is_draft: true, content: { text: "Slovenski osnutek" } });
    expect(byItem[fixed]).toMatchObject({ language: "all", is_draft: false });
    expect(byItem[draftOnly]).toMatchObject({ language: "en", is_draft: true });

    const en = await run(who, `select * from cms_resolve_items(array['${live}']::uuid[], 'en', true)`);
    expect(en.rows[0]).toMatchObject({ version: 3, is_draft: true, content: { text: "English draft" } });

    const layout = await run(who, `select * from cms_read_layout('home', true)`);
    expect(layout.rows[0]).toMatchObject({ version: 2, is_draft: true });
    const livePage = await run(who, `select * from cms_read_layout('home')`);
    expect(livePage.rows[0]).toMatchObject({ version: 1, is_draft: false });
  });

  it("more than 500 ids at once is refused", async () => {
    const many = `array(select gen_random_uuid() from generate_series(1, 501))`;
    expect((await run(visitor, `select * from cms_resolve_items(${many}, 'en')`)).code).toBe("22023");
  });

  it.each(roles)("%s: can list the templates", async (_name, who) => {
    const templates = await run(who, `select key from cms_list_templates()`);
    expect(templates.rows.map((r) => r.key)).toEqual(expect.arrayContaining(["banner-section", "help-section", "timeline-section"]));
  });
});

describe("reads for editors", () => {
  const readers = (item: string) => [
    `select * from cms_read_newest('${item}', 'en')`,
    `select * from cms_list_versions('${item}', 'en')`,
    `select * from cms_list_items()`,
    `select * from cms_list_usages('${bannerId}')`,
    `select * from cms_read_layout_newest('home')`,
    `select * from cms_list_layout_versions('home')`,
    `select * from cms_list_layouts()`,
  ];

  it("a visitor cannot call them", async () => {
    for (const statement of readers(live)) expect((await run(visitor, statement)).error, statement).toMatch(/permission denied/);
  });

  it.each(lowRoles.slice(1))("%s gets an empty result", async (_name, who) => {
    for (const statement of readers(live)) {
      const outcome = await run(who, statement);
      expect(outcome.error, statement).toBeUndefined();
      expect(outcome.rows, statement).toEqual([]);
    }
  });

  it.each(canEdit)("%s reads drafts, history, who saved, the list and the usages", async (_name, who) => {
    const newest = await run(who, `select * from cms_read_newest('${live}', 'en')`);
    expect(newest.rows).toHaveLength(1);
    expect(newest.rows[0]).toMatchObject({ version: 3, status: "draft", content: { text: "English draft" }, changed_by: EDITOR, changed_by_email: `${EDITOR}@example.test` });
    const versions = await run(who, `select * from cms_list_versions('${live}', 'en')`);
    expect(versions.rows.map((r) => r.version)).toEqual([3, 2, 1]);
    expect(Object.keys(versions.rows[0]!)).not.toContain("content");

    const list = await run(who, `select * from cms_list_items()`);
    expect(list.rows.map((r) => r.id)).toEqual(expect.arrayContaining([live, fixed, draftOnly]));
    expect(list.rows.find((r) => r.id === live)).toMatchObject({ title: "Live card", published_languages: ["de", "en"] });
    expect((await run(who, `select * from cms_list_items('banner')`)).rows.map((r) => r.id)).toEqual([bannerId]);
    expect(list.rows.find((r) => r.id === bannerId)?.usage_count).toBe(2); // the live card (de) and the home layout

    const usages = await run(who, `select * from cms_list_usages('${bannerId}') order by source_kind`);
    expect(usages.rows.map((r) => [r.source_kind, r.source_label])).toEqual([
      ["item", "Live card"],
      ["layout", "home"],
    ]);
    expect((await run(who, `select * from cms_read_layout_newest('home')`)).rows[0]).toMatchObject({ version: 2, status: "draft" });
    expect((await run(who, `select * from cms_list_layouts()`)).rows).toHaveLength(1);
  });
});

describe("writes", () => {
  const editorWrites = (): [string, string][] => [
    ["cms_create_item", sql.createItem("card", "New", false, true)],
    ["cms_update_item", `select * from cms_update_item('${live}', 'Renamed', null)`],
    ["cms_save_item_draft", sql.save(live, "en", 3, { text: "again" })],
    ["cms_publish_item", sql.publish(live, "en", 3)],
    ["cms_restore_item", sql.restore(live, "en", 1, 3)],
    ["cms_save_layout_draft", sql.saveLayout("home", 2, { sections: [] })],
    ["cms_publish_layout", sql.publishLayout("home", 2)],
    ["cms_restore_layout", sql.restoreLayout("home", 1, 2)],
    ["cms_reorder_slot", `select cms_reorder_slot('home', 2, 'top', 'banner', array['${bannerId}']::uuid[])`],
    ["cms_register_asset", `select * from cms_register_asset('a.png', 'image/png', 10, 1, 1, null)`],
  ];
  const ownerWrites = (): [string, string][] => [
    ["cms_delete_item", `select cms_delete_item('${draftOnly}')`],
    ["cms_save_template", `select * from cms_save_template('x-section', 'X', 'section', '[{"key":"a","label":"A","allowedTypeKeys":["card"],"min":0,"max":2}]'::jsonb)`],
  ];

  beforeAll(async () => {
    await admin(`insert into storage.buckets (id, name, public) values ('site-images', 'site-images', true) on conflict do nothing`);
    await admin(`insert into storage.objects (bucket_id, name) values ('site-images', 'a.png')`);
  });

  it.each(lowRoles)("%s: no content write, and nothing is written", async (_name, who) => {
    const before = (await admin(`select (select count(*) from cms_items) as i, (select count(*) from cms_item_versions) as v, (select count(*) from cms_change_log) as l`)).rows[0];
    for (const [name, statement] of [...editorWrites(), ...ownerWrites()]) {
      const outcome = await run(who, statement);
      expect(outcome.code, name).toBe("42501");
    }
    const after = (await admin(`select (select count(*) from cms_items) as i, (select count(*) from cms_item_versions) as v, (select count(*) from cms_change_log) as l`)).rows[0];
    expect(after).toEqual(before);
  });

  it("members and strangers are refused inside the function too, not only by the grant", async () => {
    // Grant execute to everyone for a moment, to prove the role check inside the function is a second guard.
    await admin(`grant execute on function cms_create_item(text, text, boolean, boolean), cms_delete_item(uuid) to anon`);
    try {
      expect((await run(visitor, sql.createItem("card", "x", false, true))).error).toMatch(/Only editors and owners/);
      expect((await run(visitor, `select cms_delete_item('${draftOnly}')`)).error).toMatch(/Only owners/);
    } finally {
      await admin(`revoke execute on function cms_create_item(text, text, boolean, boolean), cms_delete_item(uuid) from anon`);
    }
  });

  it("an editor does the editor's writes", async () => {
    for (const [name, statement] of editorWrites()) {
      const outcome = await run(as(EDITOR), statement);
      expect(outcome.error, name).toBeUndefined();
    }
  });

  it("an editor cannot delete an item or save a template", async () => {
    for (const [name, statement] of ownerWrites()) {
      const outcome = await run(as(EDITOR), statement);
      expect(outcome.code, name).toBe("42501");
      expect(outcome.error, name).toMatch(/Only owners/);
    }
  });

  it("an owner does everything an editor does, and the owner-only writes", async () => {
    for (const [name, statement] of [...editorWrites(), ...ownerWrites()]) {
      const outcome = await run(as(OWNER), statement);
      expect(outcome.error, name).toBeUndefined();
    }
  });

  it("an editor's save records who saved it, as the caller", async () => {
    const saved = await run(as(OWNER), sql.save(live, "en", 3, { text: "by the owner" }), true);
    expect(saved.rows[0]!.v).toBe(4);
    const row = (await run(as(EDITOR), `select * from cms_read_newest('${live}', 'en')`)).rows[0]!;
    expect(row.changed_by).toBe(OWNER);
    expect(parse(JSON.stringify(row.content))).toEqual({ text: "by the owner" });
  });
});
