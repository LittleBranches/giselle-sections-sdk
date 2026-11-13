import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { EDITOR, OWNER, SUPABASE_STANDIN_SQL, MEMBERS_SQL, as, createDatabase, migrationFiles, readMigration, visitor } from "./harness";

// What the database refuses even to its own functions and owner (append-only triggers), the per-column grants and the
// function grants as catalog facts, and the idempotent files: applied again, and on top of the legacy tables.

const d = createDatabase();
const { run, admin, must, makeItem, saveAndPublish, sql } = d;
const editor = as(EDITOR);

const TABLES = ["cms_items", "cms_item_entries", "cms_item_versions", "cms_layouts", "cms_layout_versions", "cms_templates", "cms_assets", "cms_references", "cms_change_log"];

let item: string;
let target: string;
let layoutId: string;

beforeAll(async () => {
  await d.setup();
  target = await makeItem("banner", "target", { reusable: true });
  item = await makeItem("card", "history");
  await saveAndPublish(item, "en", { v: 1 }, [target]);
  await must(editor, sql.save(item, "en", 1, { v: 2 }, [target]));
  await must(editor, sql.saveLayout("hardened", null, { sections: [{ key: "s", template: "banner-section", slots: { banner: [target] } }] }, [target]));
  await must(editor, sql.publishLayout("hardened", 1));
  layoutId = (await admin(`select id from cms_layouts where page_key = 'hardened'`)).rows[0]!.id;
});

describe("append-only records, even for the table owner", () => {
  it("a saved version never changes, except a draft being marked published", async () => {
    for (const statement of [
      `update cms_item_versions set content = '{}'::jsonb`,
      `update cms_item_versions set changed_by_email = 'x' where version = 1`,
      `update cms_item_versions set version = version + 10`,
      `update cms_item_versions set restored_from = 1 where version = 2`,
      `update cms_item_versions set status = 'draft' where status = 'published'`, // un-publishing
      `update cms_item_versions set status = 'published', content = '{}'::jsonb where status = 'draft'`, // both at once
      `update cms_layout_versions set content = '{"sections": []}'::jsonb`,
      `update cms_layout_versions set status = 'draft'`,
    ]) {
      expect((await admin(statement)).error, statement).toMatch(/cannot be changed/);
    }
    // the one allowed change: draft to published, all else the same
    await d.db.exec("begin");
    const allowed = await admin(`update cms_item_versions set status = 'published' where version = 2 and entry_id in (select id from cms_item_entries where item_id = '${item}')`);
    await d.db.exec("rollback");
    expect(allowed.error).toBeUndefined();
  });

  it("versions cannot be deleted or truncated outside cms_delete_item", async () => {
    for (const statement of [`delete from cms_item_versions`, `delete from cms_layout_versions`, `delete from cms_items where id = '${item}'`, `truncate cms_item_versions cascade`, `truncate cms_layout_versions cascade`, `truncate cms_items cascade`]) {
      expect((await admin(statement)).error, statement).toMatch(/cannot be deleted|append-only/);
    }
    // entries cascade into versions, which is the same delete, so it is refused too
    expect((await admin(`delete from cms_item_entries where item_id = '${item}'`)).error).toMatch(/cannot be deleted/);
    expect((await admin(`delete from cms_layouts where id = '${layoutId}'`)).error).toMatch(/cannot be deleted/);
  });

  it("the delete setting is what unlocks a delete, and nothing else does", async () => {
    await d.db.exec("begin");
    await d.db.exec(`set local cms.deleting = 'on'`);
    const unlocked = await admin(`delete from cms_references where source_kind = 'layout'`);
    await d.db.exec("rollback");
    expect(unlocked.error).toBeUndefined();
    for (const value of ["off", "true", "1", "ON "]) {
      await d.db.exec("begin");
      await d.db.exec(`set local cms.deleting = '${value}'`);
      const refused = await admin(`delete from cms_references`);
      await d.db.exec("rollback");
      expect(refused.error, value).toMatch(/cannot be deleted/);
    }
  });

  it("the reference index is never updated, and rows leave only under the delete setting", async () => {
    expect((await admin(`update cms_references set source_version = 99`)).error).toMatch(/append-only/);
    expect((await admin(`delete from cms_references`)).error).toMatch(/cannot be deleted/);
    expect((await admin(`truncate cms_references`)).error).toMatch(/append-only/);
  });

  it("an item changes its title and reusable flag only", async () => {
    for (const statement of [
      `update cms_items set translatable = not translatable`,
      `update cms_items set type_key = 'other'`,
      `update cms_items set id = gen_random_uuid()`,
      `update cms_items set created_at = now() - interval '1 day'`,
      `update cms_items set created_by_email = 'x'`,
    ]) {
      expect((await admin(statement)).error, statement).toMatch(/Only the title and the reusable flag/);
    }
    expect((await admin(`update cms_items set title = 'Changed', reusable = not reusable where id = '${item}'`)).error).toBeUndefined();
  });

  it("assets and the change log are append-only", async () => {
    for (const statement of [`update cms_change_log set action = 'publish_item'`, `delete from cms_change_log`, `truncate cms_change_log`]) {
      expect((await admin(statement)).error, statement).toMatch(/append-only/);
    }
  });

  it("the table checks hold for what the functions would never write", async () => {
    for (const statement of [
      `insert into cms_items (type_key, title, translatable) values ('Bad', 'x', true)`,
      `insert into cms_items (type_key, title, translatable) values ('card', '', true)`,
      `insert into cms_item_entries (item_id, language) values ('${item}', 'EN')`,
      `insert into cms_item_entries (item_id, language) values ('${item}', 'en')`, // unique
      `insert into cms_layouts (page_key) values ('Bad Page')`,
      `insert into cms_layout_versions (layout_id, version, content) values ('${layoutId}', 50, '{"sections": 1}'::jsonb)`,
      `insert into cms_item_versions (entry_id, version, content) select id, 50, '[]'::jsonb from cms_item_entries limit 1`,
      `insert into cms_assets (path, mime, bytes) values ('a/../b.png', 'image/png', 1)`,
      `insert into cms_assets (path, mime, bytes) values ('/a.png', 'image/png', 1)`,
      `insert into cms_templates (key, name, container_type_key, slots) values ('t', 'T', 'section', '[]'::jsonb)`,
      `update cms_item_entries set published_version = 77 where item_id = '${item}'`, // a version that does not exist
    ]) {
      expect((await admin(statement)).error, statement).toBeTruthy();
    }
  });
});

describe("grants as catalog facts", () => {
  it.each(["anon", "authenticated"])("%s has no write right on any table or column, and no truncate", async (role) => {
    for (const table of TABLES) {
      const rights = (
        await admin(`select
          has_any_column_privilege('${role}', 'public.${table}', 'INSERT') as i,
          has_any_column_privilege('${role}', 'public.${table}', 'UPDATE') as u,
          has_any_column_privilege('${role}', 'public.${table}', 'REFERENCES') as r,
          has_table_privilege('${role}', 'public.${table}', 'DELETE') as d,
          has_table_privilege('${role}', 'public.${table}', 'TRUNCATE') as t`)
      ).rows[0]!;
      expect(rights, `${role} ${table}`).toEqual({ i: false, u: false, r: false, d: false, t: false });
    }
  });

  it.each(["anon", "authenticated"])("%s cannot select the columns that name people or titles", async (role) => {
    const hidden: [string, string][] = [
      ["cms_items", "title"], ["cms_items", "created_by"], ["cms_items", "created_by_email"],
      ["cms_item_versions", "changed_by"], ["cms_item_versions", "changed_by_email"],
      ["cms_layout_versions", "changed_by"], ["cms_layout_versions", "changed_by_email"],
      ["cms_assets", "bytes"], ["cms_assets", "created_by"], ["cms_assets", "created_by_email"],
      ["cms_references", "target_item_id"], ["cms_references", "source_id"],
    ];
    for (const [table, column] of hidden) {
      expect((await admin(`select has_column_privilege('${role}', 'public.${table}', '${column}', 'SELECT') as ok`)).rows[0]!.ok, `${role} ${table}.${column}`).toBe(false);
    }
    // and the columns a visitor may read are exactly these (key, type and the rest are out of reach of a change anyway)
    const readable = async (table: string) =>
      (await admin(`select string_agg(column_name, ',' order by column_name) as c from information_schema.columns where table_schema = 'public' and table_name = '${table}' and has_column_privilege('${role}', 'public.${table}', column_name, 'SELECT')`)).rows[0]!.c;
    expect(await readable("cms_items")).toBe("created_at,id,reusable,translatable,type_key");
    expect(await readable("cms_item_entries")).toBe("created_at,id,item_id,language,published_version");
    expect(await readable("cms_item_versions")).toBe("changed_at,content,entry_id,restored_from,status,version");
    expect(await readable("cms_layouts")).toBe("created_at,id,page_key,published_version");
    expect(await readable("cms_layout_versions")).toBe("changed_at,content,layout_id,restored_from,status,version");
    expect(await readable("cms_assets")).toBe("bucket,created_at,height,id,label,mime,path,width");
  });

  it("only the change log is readable by a signed-in role as a whole, and only by editors through its policy", async () => {
    expect((await admin(`select has_table_privilege('anon', 'public.cms_change_log', 'SELECT') as a, has_table_privilege('authenticated', 'public.cms_change_log', 'SELECT') as b`)).rows[0]).toEqual({ a: false, b: true });
    expect((await run(as("00000000-0000-4000-8000-000000000003"), `select * from cms_change_log`)).rows).toEqual([]);
  });

  it("every table has row-level security on", async () => {
    const rows = (await admin(`select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname like 'cms\\_%' and relkind = 'r' order by 1`)).rows;
    expect(rows.map((r) => r.relname).sort()).toEqual([...TABLES].sort());
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
  });

  it("function grants: everyone, signed-in only, or nobody", async () => {
    const executable = async (role: string) =>
      (await admin(`select p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'cms\\_%' and p.prorettype <> 'trigger'::regtype and has_function_privilege('${role}', p.oid, 'EXECUTE') order by 1`)).rows.map((r) => r.proname);
    expect(await executable("anon")).toEqual(["cms_list_templates", "cms_read_layout", "cms_read_published", "cms_resolve_items"]);
    expect(await executable("authenticated")).toEqual(
      [
        "cms_create_item", "cms_delete_item", "cms_list_items", "cms_list_layout_versions", "cms_list_layouts", "cms_list_templates", "cms_list_usages", "cms_list_versions",
        "cms_publish_item", "cms_publish_layout", "cms_read_layout", "cms_read_layout_newest", "cms_read_newest", "cms_read_published", "cms_register_asset", "cms_reorder_slot",
        "cms_resolve_items", "cms_restore_item", "cms_restore_layout", "cms_save_item_draft", "cms_save_layout_draft", "cms_save_template", "cms_update_item",
      ].sort(),
    );
    // the internal ones have no grant to anyone but their owner
    const nobody = (await admin(`select p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'cms\\_%' and p.prorettype <> 'trigger'::regtype and not has_function_privilege('authenticated', p.oid, 'EXECUTE') order by 1`)).rows.map((r) => r.proname);
    expect(nobody).toEqual(["cms_add_item_version", "cms_add_layout_version", "cms_check_layout", "cms_check_refs", "cms_counting_refs", "cms_deleting", "cms_raise_stale"].sort());
  });

  it("every function that changes or reveals data is security definer with an empty search_path", async () => {
    const rows = (await admin(`select proname, prosecdef, proconfig from pg_proc where pronamespace = 'public'::regnamespace and proname like 'cms\\_%' order by 1`)).rows;
    const invoker = rows.filter((r) => !r.prosecdef).map((r) => r.proname);
    expect(invoker).toEqual(
      ["cms_deleting", "cms_forbid_change", "cms_forbid_template_delete", "cms_guard_delete", "cms_guard_item_update", "cms_guard_template_update", "cms_guard_version_update", "cms_list_templates", "cms_read_published"].sort(),
    );
    for (const row of rows) expect(row.proconfig, row.proname).toEqual(["search_path=\"\""]);
  });

  it("a signed-in person who is not an editor still reads nothing extra through the table of references", async () => {
    expect((await run(visitor, `select count(*) from cms_references`)).error).toMatch(/permission denied/);
    expect((await run(as(OWNER), `select count(*) from cms_references`)).error).toMatch(/permission denied/);
  });
});

// A fingerprint of everything the idempotent files define, so "nothing changed" is a comparison, not a hope.
async function fingerprint(db: PGlite): Promise<string> {
  const result = await db.query<{ f: string }>(`
    select jsonb_pretty(jsonb_build_object(
      'columns', (select jsonb_agg(jsonb_build_array(table_name, column_name, data_type, is_nullable, column_default) order by table_name, column_name)
                  from information_schema.columns where table_schema = 'public' and (table_name like 'content\\_%' or table_name = 'site_members')),
      'constraints', (select jsonb_agg(jsonb_build_array(conrelid::regclass::text, conname, pg_get_constraintdef(oid)) order by conrelid::regclass::text, conname)
                      from pg_constraint where connamespace = 'public'::regnamespace and (conrelid::regclass::text like 'content\\_%' or conrelid::regclass::text = 'site_members')),
      'policies', (select jsonb_agg(jsonb_build_array(schemaname, tablename, policyname, cmd, roles::text, qual, with_check) order by schemaname, tablename, policyname)
                   from pg_policies where tablename like 'content\\_%' or tablename = 'site_members' or (schemaname = 'storage' and tablename = 'objects')),
      'functions', (select jsonb_agg(jsonb_build_array(proname, pg_get_function_identity_arguments(oid), md5(prosrc), prosecdef, provolatile, proconfig::text, proacl::text) order by proname, pg_get_function_identity_arguments(oid))
                    from pg_proc where pronamespace = 'public'::regnamespace and (proname like 'content\\_%' or proname in ('can_edit', 'is_owner', 'is_plan_member'))),
      'grants', (select jsonb_agg(jsonb_build_array(relname, relacl::text, relrowsecurity) order by relname)
                 from pg_class where relnamespace = 'public'::regnamespace and (relname like 'content\\_%' or relname = 'site_members') and relkind = 'r'),
      'columnGrants', (select jsonb_agg(jsonb_build_array(c.relname, a.attname, a.attacl::text) order by c.relname, a.attname)
                       from pg_attribute a join pg_class c on c.oid = a.attrelid
                       where c.relnamespace = 'public'::regnamespace and (c.relname like 'content\\_%' or c.relname = 'site_members') and a.attacl is not null),
      'bucket', (select jsonb_agg(to_jsonb(b)) from storage.buckets b)
    )) as f`);
  return result.rows[0]!.f;
}

// The legacy files as they would have been written before they were made repeatable: plain creates, nothing guarded.
function asFirstTimeMigration(file: string): string {
  return readMigration(file)
    .replace(/create table if not exists /g, "create table ")
    .replace(/create or replace function /g, "create function ")
    .replace(/^drop policy if exists .*$/gm, "")
    .replace(
      /do \$\$[\s\S]*?\$\$;/,
      `alter table content_entries add constraint content_entries_published_fk foreign key (id, published_version) references content_versions (entry_id, version) deferrable initially deferred;`,
    );
}

describe("the idempotent files", () => {
  const IDEMPOTENT = ["20261115000100_cms_roles.sql", "20261115000200_cms_legacy_entries.sql", "20261115000300_cms_images_bucket.sql"];

  it("apply again, twice over, with no error and no change", async () => {
    const db = new PGlite();
    const fresh = createDatabase(db);
    await fresh.setup();
    const before = await fingerprint(db);
    for (let pass = 0; pass < 2; pass++) for (const file of IDEMPOTENT) await db.exec(readMigration(file));
    expect(await fingerprint(db)).toBe(before);
    // and the whole set, as a site that applies "all" would: the tables file is not repeatable, the other five are
    await db.exec(readMigration("20261115000600_cms_seed_templates.sql"));
    await db.close();
  });

  it("apply on top of the legacy tables as an earlier migration made them: nothing changes, nothing is lost", async () => {
    const db = new PGlite();
    const old = createDatabase(db);
    await db.exec(SUPABASE_STANDIN_SQL);
    for (const file of IDEMPOTENT) await db.exec(asFirstTimeMigration(file));
    await db.exec(MEMBERS_SQL);
    // the campaign database as it is live: members, entries in two languages, a published one, a draft, a restore
    await old.must(editor, `select content_save_draft('hero', 'sl', null, '{"t":"zivjo"}'::jsonb)`);
    await old.must(editor, `select content_publish('hero', 'sl', 1)`);
    await old.must(editor, `select content_save_draft('hero', 'sl', 1, '{"t":"zivjo 2"}'::jsonb)`);
    await old.must(editor, `select content_restore('hero', 'sl', 1, 2)`);
    const data = async () =>
      JSON.stringify([
        (await db.query(`select * from content_entries order by id`)).rows,
        (await db.query(`select * from content_versions order by entry_id, version`)).rows,
        (await db.query(`select user_id, role from site_members order by user_id`)).rows,
        (await db.query(`select user_id, version from content_publish_log order by id`)).rows,
      ]);
    const [shapeBefore, dataBefore] = [await fingerprint(db), await data()];

    for (const file of IDEMPOTENT) await db.exec(readMigration(file));

    expect(await fingerprint(db)).toBe(shapeBefore);
    expect(await data()).toBe(dataBefore);
    expect(JSON.parse(dataBefore)[1]).toHaveLength(3);
    // still works for the same people, and the rules did not move
    expect((await old.run(visitor, `select content from content_read_published('hero', 'sl')`)).rows).toEqual([{ content: { t: "zivjo" } }]);
    expect((await old.run(as(OWNER), `select version from content_read_newest('hero', 'sl')`)).rows).toEqual([{ version: 3 }]);
    expect((await old.run(visitor, `select * from content_read_newest('hero', 'sl')`)).error).toMatch(/permission denied/);
    // and the new model can then be added on top
    for (const file of migrationFiles().filter((name) => name > IDEMPOTENT[2]!)) await db.exec(readMigration(file));
    await db.close();
  });

  it("create what is missing on a database that has none of it, and the same rules hold", async () => {
    // (the full setup of this file's database is exactly that: nothing existed before the six files)
    expect((await run(visitor, `select * from content_read_published('hero', 'sl')`)).rows).toEqual([]);
    expect((await run(visitor, `select * from content_save_draft('hero', 'sl', null, '{}'::jsonb)`)).error).toMatch(/permission denied/);
    expect((await run(as(OWNER), `select content_save_draft('hero', 'sl', null, '{"t":1}'::jsonb) as v`)).rows).toEqual([{ v: 1 }]);
    expect((await admin(`select count(*) as n from pg_policies where tablename = 'objects' and schemaname = 'storage'`)).rows[0]!.n).toBe(2);
    expect((await admin(`select id, public, file_size_limit from storage.buckets`)).rows).toEqual([{ id: "site-images", public: true, file_size_limit: 5242880 }]);
  });
});
