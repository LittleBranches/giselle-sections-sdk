import { beforeAll, describe, expect, it } from "vitest";

import { EDITOR, OWNER, as, createDatabase, parse } from "./harness";

// Versions of an item's entries: save with a base version, stale saves, publish, restore, the language rules of an item
// that is or is not translatable, and the fallback to English.

const d = createDatabase();
const { run, admin, must, makeItem, saveAndPublish, sql } = d;
const editor = as(EDITOR);

const count = async (item: string) =>
  Number((await admin(`select count(*) as n from cms_item_versions v join cms_item_entries e on e.id = v.entry_id where e.item_id = '${item}'`)).rows[0]!.n);

beforeAll(async () => {
  await d.setup();
});

describe("save, stale save, publish, restore", () => {
  it("numbers versions from 1, and the first save has no base", async () => {
    const item = await makeItem("card", "numbers");
    expect((await must(editor, sql.save(item, "en", null, { n: 1 })))[0]!.v).toBe(1);
    expect((await must(editor, sql.save(item, "en", 1, { n: 2 })))[0]!.v).toBe(2);
    expect((await must(editor, sql.save(item, "en", 2, { n: 3 })))[0]!.v).toBe(3);
  });

  it("refuses a stale save with CE001 and the newest version, and writes nothing", async () => {
    const item = await makeItem("card", "stale");
    await must(editor, sql.save(item, "en", null, { n: 1 }));
    await must(editor, sql.save(item, "en", 1, { n: 2 }));
    const stale = await run(editor, sql.save(item, "en", 1, { n: "mine" }));
    expect(stale.code).toBe("CE001");
    const newest = parse(stale.detail);
    expect(newest).toMatchObject({ version: 2, status: "draft", content: { n: 2 }, changedBy: EDITOR, restoredFrom: null });
    expect(await count(item)).toBe(2);

    // a first save over an entry that already has versions is stale too, as is a base from the future
    expect((await run(editor, sql.save(item, "en", null, { n: "x" }))).code).toBe("CE001");
    expect((await run(editor, sql.save(item, "en", 5, { n: "x" }))).code).toBe("CE001");
    expect(await count(item)).toBe(2);
    // and a base on an entry that has none
    const fresh = await makeItem("card", "fresh");
    expect((await run(editor, sql.save(fresh, "en", 1, { n: "x" }))).code).toBe("CE001");
    expect((await admin(`select count(*) as n from cms_item_entries where item_id = '${fresh}'`)).rows[0]!.n).toBe(0);
  });

  it("refuses content that is not an object, and an unknown item", async () => {
    const item = await makeItem("card", "shape");
    expect((await run(editor, `select cms_save_item_draft('${item}', 'en', null, '[1]'::jsonb, '{}')`)).code).toBe("22023");
    expect((await run(editor, `select cms_save_item_draft('${item}', 'en', null, 'null'::jsonb, '{}')`)).code).toBe("22023");
    expect((await run(editor, sql.save("11111111-1111-4111-8111-111111111111", "en", null, {}))).code).toBe("CM001");
  });

  it("publishes only the newest version, and a stale publish changes nothing", async () => {
    const item = await makeItem("card", "publish");
    await must(editor, sql.save(item, "en", null, { n: 1 }));
    await must(editor, sql.save(item, "en", 1, { n: 2 }));

    const old = await run(editor, sql.publish(item, "en", 1));
    expect(old.code).toBe("CE001");
    expect(parse(old.detail)).toMatchObject({ version: 2 });
    expect((await run(editor, sql.publish(item, "en", 3))).code).toBe("CE001");
    expect((await admin(`select published_version from cms_item_entries where item_id = '${item}'`)).rows[0]!.published_version).toBeNull();
    expect((await admin(`select count(*) as n from cms_change_log where subject_id = '${item}'`)).rows[0]!.n).toBe(0);

    await must(editor, sql.publish(item, "en", 2));
    const entry = (await admin(`select published_version from cms_item_entries where item_id = '${item}'`)).rows[0]!;
    expect(entry.published_version).toBe(2);
    expect((await admin(`select version, status from cms_item_versions v join cms_item_entries e on e.id = v.entry_id where e.item_id = '${item}' order by version`)).rows).toEqual([
      { version: 1, status: "draft" },
      { version: 2, status: "published" },
    ]);
  });

  it("publishing what is already live changes nothing and is not logged again", async () => {
    const item = await makeItem("card", "twice");
    await saveAndPublish(item, "en", { n: 1 });
    await must(editor, sql.publish(item, "en", 1));
    const log = await admin(`select action, language, version, user_id from cms_change_log where subject_id = '${item}'`);
    expect(log.rows).toEqual([{ action: "publish_item", language: "en", version: 1, user_id: EDITOR }]);
  });

  it("publishing nothing is refused", async () => {
    const item = await makeItem("card", "nothing");
    expect((await run(editor, sql.publish(item, "en", 1))).code).toBe("22023");
    expect((await run(editor, sql.publish("11111111-1111-4111-8111-111111111111", "en", 1))).code).toBe("CM001");
  });

  it("a later draft leaves the live version in place until it is published", async () => {
    const item = await makeItem("card", "live");
    await saveAndPublish(item, "en", { n: 1 });
    await must(editor, sql.save(item, "en", 1, { n: 2 }));
    expect((await run(as(EDITOR), `select version from cms_read_published('${item}', 'en')`)).rows[0]!.version).toBe(1);
    await must(editor, sql.publish(item, "en", 2));
    expect((await run(as(EDITOR), `select version from cms_read_published('${item}', 'en')`)).rows[0]!.version).toBe(2);
  });

  it("restore makes a new version from an old one, and leaves the old one alone", async () => {
    const item = await makeItem("card", "restore");
    await saveAndPublish(item, "en", { words: "first" });
    await must(editor, sql.save(item, "en", 1, { words: "second" }));
    const restored = await must(as(OWNER), sql.restore(item, "en", 1, 2));
    expect(restored[0]!.v).toBe(3);
    const rows = (await admin(`select version, status, content, restored_from, changed_by from cms_item_versions v join cms_item_entries e on e.id = v.entry_id where e.item_id = '${item}' order by version`)).rows;
    expect(rows).toEqual([
      { version: 1, status: "published", content: { words: "first" }, restored_from: null, changed_by: EDITOR },
      { version: 2, status: "draft", content: { words: "second" }, restored_from: null, changed_by: EDITOR },
      { version: 3, status: "draft", content: { words: "first" }, restored_from: 1, changed_by: OWNER },
    ]);
    // the restore is only a draft: the live version did not move
    expect((await admin(`select published_version from cms_item_entries where item_id = '${item}'`)).rows[0]!.published_version).toBe(1);
  });

  it("a restore carries a stale base and an unknown version as refusals", async () => {
    const item = await makeItem("card", "restore-refused");
    await saveAndPublish(item, "en", { n: 1 });
    await must(editor, sql.save(item, "en", 1, { n: 2 }));
    const stale = await run(editor, sql.restore(item, "en", 1, 1));
    expect(stale.code).toBe("CE001");
    expect(parse(stale.detail)).toMatchObject({ version: 2 });
    expect((await run(editor, sql.restore(item, "en", 9, 2))).code).toBe("22023");
    expect(await count(item)).toBe(2);
  });

  it("two saves from the same base: the second is refused, whichever order (one at a time)", async () => {
    const item = await makeItem("card", "race");
    await must(editor, sql.save(item, "en", null, { n: 1 }));
    const [first, second] = [await run(editor, sql.save(item, "en", 1, { by: "a" }), true), await run(editor, sql.save(item, "en", 1, { by: "b" }), true)];
    expect(first.error).toBeUndefined();
    expect(second.code).toBe("CE001");
    expect(parse(second.detail)).toMatchObject({ version: 2, content: { by: "a" } });
  });
});

describe("items and languages", () => {
  it("validates what an item is made of", async () => {
    for (const [type, title] of [
      ["Bad Key", "ok"],
      ["1card", "ok"],
      ["card", ""],
      ["card", "x".repeat(121)],
      ["x".repeat(65), "ok"],
    ] as const) {
      expect((await run(editor, sql.createItem(type, title, false, true))).code, `${type} ${title.length}`).toBe("22023");
    }
    expect((await run(editor, sql.createItem("card", "x".repeat(120), false, true))).error).toBeUndefined();
    expect((await run(editor, `select * from cms_create_item('card', 'ok', false, null)`)).code).toBe("22023");
  });

  it("a translatable item has one entry per real language, and never 'all'", async () => {
    const item = await makeItem("card", "translated");
    await must(editor, sql.save(item, "en", null, { t: "en" }));
    await must(editor, sql.save(item, "sl", null, { t: "sl" }));
    expect((await run(editor, sql.save(item, "all", null, { t: "all" }))).code).toBe("22023");
    expect((await run(editor, sql.save(item, "EN", null, { t: "x" }))).code).toBe("22023");
    expect((await run(editor, `select cms_save_item_draft('${item}', null, null, '{}'::jsonb, '{}')`)).code).toBe("22023");
    expect((await admin(`select language from cms_item_entries where item_id = '${item}' order by language`)).rows.map((r) => r.language)).toEqual(["en", "sl"]);
  });

  it("an item that is not translatable keeps one entry, in the language 'all'", async () => {
    const item = await makeItem("card", "fixed", { translatable: false });
    expect((await run(editor, sql.save(item, "en", null, { t: 1 }))).code).toBe("22023");
    expect((await run(editor, sql.save(item, "sl", null, { t: 1 }))).code).toBe("22023");
    await must(editor, sql.save(item, "all", null, { t: 1 }));
    await must(editor, sql.save(item, "all", 1, { t: 2 }));
    expect((await admin(`select language from cms_item_entries where item_id = '${item}'`)).rows).toEqual([{ language: "all" }]);
  });

  it("whether an item is translatable is fixed at creation", async () => {
    const item = await makeItem("card", "frozen");
    expect((await admin(`update cms_items set translatable = false where id = '${item}'`)).error).toMatch(/Only the title and the reusable flag/);
    expect((await run(editor, `select * from cms_update_item('${item}', 'New title', true)`, true)).rows[0]).toMatchObject({ title: "New title", reusable: true, translatable: true, type_key: "card" });
    // null leaves a field as it is
    expect((await run(editor, `select * from cms_update_item('${item}', null, null)`)).rows[0]).toMatchObject({ title: "New title", reusable: true });
    expect((await run(editor, `select * from cms_update_item('${item}', '', null)`)).code).toBe("22023");
    expect((await run(editor, `select * from cms_update_item('11111111-1111-4111-8111-111111111111', 'x', null)`)).code).toBe("CM001");
  });
});

describe("fallback to English, as the database does it", () => {
  const resolve = (who: Parameters<typeof run>[0], ids: string[], language: string, preview = false) =>
    run(who, `select * from cms_resolve_items(array[${ids.map((i) => `'${i}'`).join(",")}]::uuid[], '${language}', ${preview})`);
  const visitorWho = { role: "anon" as const };

  it("a missing translation shows the English words; a present one wins", async () => {
    const item = await makeItem("card", "words");
    await saveAndPublish(item, "en", { t: "hello" });
    await saveAndPublish(item, "de", { t: "hallo" });
    const asked = async (language: string) => (await resolve(visitorWho, [item], language)).rows[0]!;
    expect(await asked("de")).toMatchObject({ language: "de", content: { t: "hallo" } });
    expect(await asked("sl")).toMatchObject({ language: "en", content: { t: "hello" } });
    expect(await asked("en")).toMatchObject({ language: "en" });
    expect(await asked("xx")).toMatchObject({ language: "en" });
  });

  it("an unpublished translation falls back to English for a visitor", async () => {
    const item = await makeItem("card", "pending");
    await saveAndPublish(item, "en", { t: "hello" });
    await must(editor, sql.save(item, "sl", null, { t: "živjo" }));
    expect((await resolve(visitorWho, [item], "sl")).rows[0]).toMatchObject({ language: "en" });
  });

  it("with no English entry and no entry in the language, there is nothing to show", async () => {
    const item = await makeItem("card", "only-de");
    await saveAndPublish(item, "de", { t: "hallo" });
    expect((await resolve(visitorWho, [item], "sl")).rows).toEqual([]);
    expect((await resolve(visitorWho, [item], "de")).rows).toHaveLength(1);
  });

  it("an item that is not translatable is the entry 'all', whatever language is asked", async () => {
    const item = await makeItem("card", "everywhere", { translatable: false });
    await saveAndPublish(item, "all", { t: "same" });
    for (const language of ["sl", "en", "de", "all"]) {
      expect((await resolve(visitorWho, [item], language)).rows[0], language).toMatchObject({ language: "all", translatable: false, content: { t: "same" } });
    }
  });

  it("answers many items at once, each with its own fallback, and skips the ones with nothing", async () => {
    const [a, b, c] = [await makeItem("card", "a"), await makeItem("card", "b"), await makeItem("card", "c")];
    await saveAndPublish(a, "de", { t: "a-de" });
    await saveAndPublish(a, "en", { t: "a-en" });
    await saveAndPublish(b, "en", { t: "b-en" });
    await must(editor, sql.save(c, "de", null, { t: "draft only" }));
    const rows = (await resolve(visitorWho, [a, b, c, a], "de")).rows;
    expect(rows.map((r) => `${r.item_id === a ? "a" : "b"}:${r.language}`).sort()).toEqual(["a:de", "b:en"]);
    expect(rows[0]).toHaveProperty("type_key", "card");
  });
});
