import { beforeAll, describe, expect, it } from "vitest";

import { EDITOR, OWNER, as, createDatabase, parse } from "./harness";

// References between items and from layouts: dangling ones, cycles (and long chains that are not cycles), items that are
// not reusable, the usage list, and deleting an item that is still used.

const d = createDatabase();
const { run, admin, must, makeItem, saveAndPublish, sql } = d;
const editor = as(EDITOR);
const owner = as(OWNER);
const GONE = "22222222-2222-4222-8222-222222222222";

const refsOf = async (item: string) =>
  (await admin(`select r.source_version, r.target_item_id from cms_references r join cms_item_entries e on e.id = r.source_id where r.source_kind = 'item' and e.item_id = '${item}' order by 1, 2`)).rows;

beforeAll(async () => {
  await d.setup();
});

describe("dangling references", () => {
  it("CM003 lists the missing ids, and nothing is written", async () => {
    const real = await makeItem("card", "real", { reusable: true });
    const holder = await makeItem("card", "holder");
    const refused = await run(editor, sql.save(holder, "en", null, { cards: [{ $ref: real }, { $ref: GONE }] }, [real, GONE]));
    expect(refused.code).toBe("CM003");
    expect(parse(refused.detail)).toEqual([GONE]);
    expect((await admin(`select count(*) as n from cms_item_entries where item_id = '${holder}'`)).rows[0]!.n).toBe(0);
    expect((await admin(`select count(*) as n from cms_references`)).rows[0]!.n).toBe(0);
  });

  it("a layout save with a missing item is CM003 when listed, and a slot rule problem when not", async () => {
    const layout = { sections: [{ key: "top", template: "banner-section", slots: { banner: [GONE] } }] };
    const listed = await run(editor, sql.saveLayout("dangling", null, layout, [GONE]));
    expect(listed.code).toBe("CM003");
    const unlisted = await run(editor, sql.saveLayout("dangling", null, layout, []));
    expect(unlisted.code).toBe("CM004");
    expect(parse(unlisted.detail)[0]).toMatchObject({ section: "top", slot: "banner" });
  });

  it("a restore checks the references again", async () => {
    const target = await makeItem("card", "soon gone", { reusable: true });
    const holder = await makeItem("card", "restorer");
    await saveAndPublish(target, "en", { t: 1 });
    await must(editor, sql.save(holder, "en", null, { c: { $ref: target } }, [target])); // v1 refers
    await must(editor, sql.save(holder, "en", 1, { c: null }, [])); // v2 does not
    await must(editor, sql.publish(holder, "en", 2)); // so v1 no longer counts
    await must(owner, `select cms_delete_item('${target}')`);
    const refused = await run(editor, sql.restore(holder, "en", 1, 2));
    expect(refused.code).toBe("CM003");
    expect(parse(refused.detail)).toEqual([target]);
    expect((await refsOf(holder)).map((r) => r.source_version)).toEqual([1]);
  });

  it("a restore copies the old version's references to the new version", async () => {
    const target = await makeItem("card", "kept", { reusable: true });
    const holder = await makeItem("card", "restorer-2");
    await must(editor, sql.save(holder, "en", null, { c: { $ref: target } }, [target]));
    await must(editor, sql.save(holder, "en", 1, { c: null }, []));
    await must(editor, sql.restore(holder, "en", 1, 2));
    expect(await refsOf(holder)).toEqual([
      { source_version: 1, target_item_id: target },
      { source_version: 3, target_item_id: target },
    ]);
  });

  it("writes one row per target and version, however often the target is listed", async () => {
    const target = await makeItem("card", "t", { reusable: true });
    const holder = await makeItem("card", "h");
    await must(editor, sql.save(holder, "en", null, {}, [target, target, target]));
    expect(await refsOf(holder)).toEqual([{ source_version: 1, target_item_id: target }]);
  });
});

describe("cycles", () => {
  it("an item cannot refer to itself", async () => {
    const a = await makeItem("card", "self", { reusable: true });
    const refused = await run(editor, sql.save(a, "en", null, {}, [a]));
    expect(refused.code).toBe("CM008");
    expect(parse(refused.detail)).toContain(a);
  });

  it("A to B, then B to A is a cycle, and the ids on it are listed", async () => {
    const [a, b] = [await makeItem("card", "a", { reusable: true }), await makeItem("card", "b", { reusable: true })];
    await must(editor, sql.save(a, "en", null, {}, [b]));
    const refused = await run(editor, sql.save(b, "en", null, {}, [a]));
    expect(refused.code).toBe("CM008");
    expect(parse(refused.detail)).toEqual([b, a, b]);
    expect(await refsOf(b)).toEqual([]);
  });

  it("finds a cycle through a long chain, and does not mistake a long chain for one", async () => {
    const chain: string[] = [];
    for (let i = 0; i < 6; i++) chain.push(await makeItem("card", `link ${i}`, { reusable: true }));
    // 0 -> 1 -> 2 -> 3 -> 4 -> 5, nothing refused however deep
    for (let i = 0; i < 5; i++) await must(editor, sql.save(chain[i]!, "en", null, {}, [chain[i + 1]!]));
    const closing = await run(editor, sql.save(chain[5]!, "en", null, {}, [chain[0]!]));
    expect(closing.code).toBe("CM008");
    expect(parse(closing.detail)).toEqual([chain[5], chain[0], chain[1], chain[2], chain[3], chain[4], chain[5]]);
    // a shortcut that does not close a circle is fine (0 -> 5 directly)
    expect((await run(editor, sql.save(chain[0]!, "en", 1, {}, [chain[1]!, chain[5]!]))).error).toBeUndefined();
  });

  it("two languages of one item refer to the same target without any cycle", async () => {
    const [a, b] = [await makeItem("card", "multi-a"), await makeItem("card", "multi-b", { reusable: true })];
    await must(editor, sql.save(a, "en", null, {}, [b]));
    await must(editor, sql.save(a, "sl", null, {}, [b]));
  });

  it("a reference that only an old version held does not make a cycle (nor count), unless it is the live one", async () => {
    const [a, b] = [await makeItem("card", "old-a", { reusable: true }), await makeItem("card", "old-b", { reusable: true })];
    await must(editor, sql.save(a, "en", null, {}, [b])); // v1 refers to b
    await must(editor, sql.save(a, "en", 1, {}, [])); // v2 does not; v1 is no longer the newest, and was never published
    await must(editor, sql.save(b, "en", null, {}, [a])); // allowed: a's counting versions do not reach b

    const [c, e] = [await makeItem("card", "live-c", { reusable: true }), await makeItem("card", "live-e", { reusable: true })];
    await must(editor, sql.save(c, "en", null, {}, [e]));
    await must(editor, sql.publish(c, "en", 1)); // v1 is live
    await must(editor, sql.save(c, "en", 1, {}, [])); // newer draft without it
    const refused = await run(editor, sql.save(e, "en", null, {}, [c])); // the live version still reaches e
    expect(refused.code).toBe("CM008");
  });

  it("a layout may hold both ends: only items make cycles", async () => {
    const [a, b] = [await makeItem("banner", "la", { reusable: true }), await makeItem("banner", "lb", { reusable: true })];
    await must(editor, sql.save(a, "en", null, {}, [b]));
    const layout = { sections: [{ key: "s", template: "banner-section", slots: { banner: [a] } }] };
    await must(editor, sql.saveLayout("cycle-free", null, layout, [a]));
  });
});

describe("items that are not reusable", () => {
  it("can be used from one source only (CM005, with the ids)", async () => {
    const mine = await makeItem("card", "page-specific"); // not reusable
    const [a, b] = [await makeItem("card", "source-a"), await makeItem("card", "source-b")];
    await must(editor, sql.save(a, "en", null, {}, [mine]));
    const refused = await run(editor, sql.save(b, "en", null, {}, [mine]));
    expect(refused.code).toBe("CM005");
    expect(parse(refused.detail)).toEqual([mine]);
    expect(await refsOf(b)).toEqual([]);
    // the same source again, in a later version, and in another language, is not "elsewhere"
    await must(editor, sql.save(a, "en", 1, { v: 2 }, [mine]));
    await must(editor, sql.save(a, "sl", null, {}, [mine]));
  });

  it("a layout counts as a source too", async () => {
    const mine = await makeItem("banner", "layout-only");
    const holder = await makeItem("card", "holder-x");
    const layout = { sections: [{ key: "s", template: "banner-section", slots: { banner: [mine] } }] };
    await must(editor, sql.saveLayout("page-x", null, layout, [mine]));
    expect((await run(editor, sql.save(holder, "en", null, {}, [mine]))).code).toBe("CM005");
    // and a second layout cannot take it either
    expect((await run(editor, sql.saveLayout("page-y", null, layout, [mine]))).code).toBe("CM005");
  });

  it("is free again once the first source no longer counts it", async () => {
    const mine = await makeItem("card", "moves");
    const [a, b] = [await makeItem("card", "first-source"), await makeItem("card", "second-source")];
    await must(editor, sql.save(a, "en", null, {}, [mine])); // v1
    await must(editor, sql.save(a, "en", 1, {}, [])); // v2: v1 is neither newest nor published
    await must(editor, sql.save(b, "en", null, {}, [mine]));
  });

  it("a reusable item may be used from any number of places", async () => {
    const shared = await makeItem("card", "shared", { reusable: true });
    for (let i = 0; i < 3; i++) await must(editor, sql.save(await makeItem("card", `user ${i}`), "en", null, {}, [shared]));
  });

  it("cms_update_item refuses to make an item not reusable while two sources use it", async () => {
    const shared = await makeItem("card", "was-shared", { reusable: true });
    const [a, b] = [await makeItem("card", "user-a"), await makeItem("card", "user-b")];
    await must(editor, sql.save(a, "en", null, {}, [shared]));
    await must(editor, sql.save(a, "sl", null, {}, [shared])); // one source with two languages
    expect((await run(editor, `select * from cms_update_item('${shared}', null, false)`)).error).toBeUndefined();
    await must(editor, sql.save(b, "en", null, {}, [shared]));
    const refused = await run(editor, `select * from cms_update_item('${shared}', null, false)`);
    expect(refused.code).toBe("CM005");
    expect(parse(refused.detail).sort()).toEqual([a, b].sort());
    expect((await admin(`select reusable from cms_items where id = '${shared}'`)).rows[0]!.reusable).toBe(true);
  });
});

describe("usages and deleting", () => {
  it("lists where an item is used, with the newest and published flags", async () => {
    const target = await makeItem("banner", "used", { reusable: true });
    const holder = await makeItem("card", "the holder");
    await must(editor, sql.save(holder, "en", null, {}, [target]));
    await must(editor, sql.publish(holder, "en", 1));
    await must(editor, sql.save(holder, "en", 1, {}, [target]));
    let usage = (await run(editor, `select * from cms_list_usages('${target}')`)).rows;
    expect(usage).toEqual([{ source_kind: "item", source_id: holder, source_label: "the holder", source_language: "en", in_published: true, in_newest: true }]);

    await must(editor, sql.save(holder, "en", 2, {}, [])); // newest now without it; the live v1 still has it
    usage = (await run(editor, `select * from cms_list_usages('${target}')`)).rows;
    expect(usage[0]).toMatchObject({ in_published: true, in_newest: false });

    const layout = { sections: [{ key: "s", template: "banner-section", slots: { banner: [target] } }] };
    await must(editor, sql.saveLayout("usage-page", null, layout, [target]));
    usage = (await run(editor, `select * from cms_list_usages('${target}') order by source_kind`)).rows;
    expect(usage.map((u) => [u.source_kind, u.source_label, u.source_language])).toEqual([
      ["item", "the holder", "en"],
      ["layout", "usage-page", null],
    ]);
  });

  it("deleting a used item is refused with CM002 and the usages, and deletes nothing", async () => {
    const target = await makeItem("banner", "protected", { reusable: true });
    await saveAndPublish(target, "en", { t: 1 });
    const holder = await makeItem("card", "protector");
    await must(editor, sql.save(holder, "en", null, {}, [target]));
    const refused = await run(owner, `select cms_delete_item('${target}')`);
    expect(refused.code).toBe("CM002");
    expect(parse(refused.detail)).toEqual([{ sourceKind: "item", sourceId: holder, sourceLabel: "protector", sourceLanguage: "en", inPublished: false, inNewest: true }]);
    expect((await admin(`select count(*) as n from cms_items where id = '${target}'`)).rows[0]!.n).toBe(1);
    expect((await admin(`select count(*) as n from cms_item_versions v join cms_item_entries e on e.id = v.entry_id where e.item_id = '${target}'`)).rows[0]!.n).toBe(1);
    expect((await admin(`select count(*) as n from cms_change_log where action = 'delete_item' and subject_id = '${target}'`)).rows[0]!.n).toBe(0);
  });

  it("a live reference still blocks the delete when the newest version dropped it", async () => {
    const target = await makeItem("banner", "live-protected", { reusable: true });
    const holder = await makeItem("card", "live-holder");
    await must(editor, sql.save(holder, "en", null, {}, [target]));
    await must(editor, sql.publish(holder, "en", 1));
    await must(editor, sql.save(holder, "en", 1, {}, []));
    expect((await run(owner, `select cms_delete_item('${target}')`)).code).toBe("CM002");
    await must(editor, sql.publish(holder, "en", 2)); // now nothing counts
    expect((await run(owner, `select cms_delete_item('${target}')`)).error).toBeUndefined();
  });

  it("a layout reference blocks the delete too", async () => {
    const target = await makeItem("banner", "layout-protected", { reusable: true });
    const layout = { sections: [{ key: "s", template: "banner-section", slots: { banner: [target] } }] };
    await must(editor, sql.saveLayout("protect-page", null, layout, [target]));
    const refused = await run(owner, `select cms_delete_item('${target}')`);
    expect(refused.code).toBe("CM002");
    expect(parse(refused.detail)[0]).toMatchObject({ sourceKind: "layout", sourceLabel: "protect-page", sourceLanguage: null });
  });

  it("deletes an unused item with its entries, versions and outgoing references, and logs it", async () => {
    const [kept, doomed] = [await makeItem("card", "kept-target", { reusable: true }), await makeItem("card", "doomed")];
    await must(editor, sql.save(doomed, "en", null, { a: 1 }, [kept]));
    await must(editor, sql.save(doomed, "sl", null, { a: 2 }, []));
    await must(editor, sql.publish(doomed, "en", 1));
    const outcome = await run(owner, `select cms_delete_item('${doomed}')`, true);
    expect(outcome.error).toBeUndefined();
    for (const table of ["cms_items where id", "cms_item_entries where item_id"]) {
      expect((await admin(`select count(*) as n from ${table} = '${doomed}'`)).rows[0]!.n, table).toBe(0);
    }
    expect((await admin(`select count(*) as n from cms_item_versions v where not exists (select 1 from cms_item_entries e where e.id = v.entry_id)`)).rows[0]!.n).toBe(0);
    expect(await refsOf(doomed)).toEqual([]);
    expect((await admin(`select action, subject_id, user_id, detail from cms_change_log where action = 'delete_item' and subject_id = '${doomed}'`)).rows).toEqual([
      { action: "delete_item", subject_id: doomed, user_id: OWNER, detail: { typeKey: "card", title: "doomed" } },
    ]);
    // the item it referred to can now be deleted by the owner too
    expect((await run(owner, `select cms_delete_item('${kept}')`)).error).toBeUndefined();
  });

  it("an old version's reference to a deleted item stays in the index, and does not block anything", async () => {
    const target = await makeItem("card", "old-target", { reusable: true });
    const holder = await makeItem("card", "old-holder");
    await must(editor, sql.save(holder, "en", null, {}, [target]));
    await must(editor, sql.save(holder, "en", 1, {}, []));
    await must(editor, sql.publish(holder, "en", 2));
    await must(owner, `select cms_delete_item('${target}')`);
    expect((await refsOf(holder)).map((r) => r.target_item_id)).toEqual([target]);
  });

  it("the delete setting does not outlive the function", async () => {
    const item = await makeItem("card", "setting");
    const other = await makeItem("card", "other");
    await d.db.exec("begin");
    await d.db.exec(`set local role authenticated`);
    await d.db.query(`select set_config('request.jwt.claim.sub', '${OWNER}', true)`);
    await d.db.exec(`select cms_delete_item('${item}')`);
    await d.db.exec(`reset role`);
    const after = await admin(`delete from cms_items where id = '${other}'`);
    await d.db.exec("rollback");
    expect(after.error).toMatch(/cannot be deleted/);
  });

  it("an unknown item is CM001", async () => {
    expect((await run(owner, `select cms_delete_item('${GONE}')`)).code).toBe("CM001");
  });
});
